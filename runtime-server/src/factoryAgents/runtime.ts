import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { hydrateImages, imagesAsText, messageText, userMessage } from "./imageRefs.js";
import { createCompactionSummaryMessage, estimateContextTokens, estimateTokens, generateSummaryWithUsage, type Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createFactoryPiAgent, createFactoryPiModels, type FactoryPiAgentOptions } from "../creatorLearning/factoryPi.js";
import { classifyFactoryProviderFailure } from "../creatorLearning/factoryLlm.js";
import { WorkbenchStore, isAssistantRole, type AgentDefinitionSource, type AnyRole, type Session } from "./store.js";
import { factoryAgentTools } from "./factoryTools.js";
import { fileTools } from "./tools.js";
import { traceAgentTools, withLangfuseTurn, type LangfuseTurnIdentifiers } from "../langfuse.js";
import { renderSystemReminder, type ClientAttributes } from "../surfaces/contract.js";
import type { Journal } from "./journal.js";
import { declareTools, studioToolSupport, type ClientSupport } from "./toolSurface.js";

const WEB: ClientAttributes = { client: "web" };

export type WorkbenchRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  agentFactory?: (options: FactoryPiAgentOptions) => Agent;
  extraTools?: (session: Session, signal: AbortSignal, changed: () => void) => Promise<AgentTool[]>;
  grantedTools?: (session: Session) => AgentTool[];
  withheldTools?: (session: Session) => Promise<string[]>;
  /** Current state for the model, rebuilt for every model call. It never enters history, so clients never see it. */
  liveState?: (sessionId: string) => Promise<string | undefined>;
  /** Which clients may run each tool. Defaults to what Studio declares. */
  toolSupport?: ClientSupport;
  /** Where public events are recorded from the first Run, and where a message is persisted together with its event. */
  journal?: Journal;
  deadlineMs?: number;
  maxTurns?: number;
};

export class WorkbenchRuntime {
  readonly events = new EventEmitter();
  private active = new Map<string, AbortController>();
  private runs = new Map<string, Promise<void>>();
  private scribeRuns = new Map<string, Promise<void>>();
  private scribeControllers = new Set<AbortController>();
  private runIds = new Map<string, string>();
  private liveAgents = new Map<string, Agent>();
  /** Messages that arrived while the run could not take them: before its model loop starts, or during compaction. */
  private held = new Map<string, AgentMessage[]>();
  private compacting = new Set<string>();
  /** The client of the latest message of each running conversation. */
  private clients = new Map<string, ClientAttributes>();
  /** Messages steered into a running agent that its history does not hold yet. A failed run writes them down: an accepted message is never lost. */
  private steered = new Map<string, Set<AgentMessage>>();
  private closing = false;
  private readonly env: NodeJS.ProcessEnv;
  constructor(readonly store: WorkbenchStore, private options: WorkbenchRuntimeOptions = {}) {
    this.env = { HATCH_FACTORY_LLM_PROFILE: "kimi-k2.6", ...(options.env ?? process.env) };
  }
  private traceIdentifiers(): LangfuseTurnIdentifiers | undefined {
    const scope = this.store.scope;
    return scope ? { productId: scope.productId, userId: scope.creatorId } : undefined;
  }
  private clientOf(id: string): ClientAttributes { return this.clients.get(id) ?? WEB; }
  emit(id: string, type: string, data: Record<string, unknown> = {}): void {
    const event = { sessionId: id, type, ...data };
    this.options.journal?.append(event);
    this.events.emit("event", event);
  }
  /** The Run in progress, if any. */
  runId(id: string): string | undefined { return this.runIds.get(id); }
  /** Persists a message and announces it as one step, so no reader sees the message without its event or the reverse. */
  async commit(id: string, persist: () => Promise<unknown>): Promise<void> {
    const event = { sessionId: id, type: "message" };
    await (this.options.journal ? this.options.journal.commit(event, persist) : persist());
    this.events.emit("event", event);
  }
  async prompt(role: AnyRole, snapshot?: Awaited<ReturnType<AgentDefinitionSource["list"]>>[number]): Promise<string> {
    const definition = snapshot ?? await this.store.definition(role);
    const dependencies = definition.dependencies;
    const folders = ["input/manual", ...[...dependencies.required, ...dependencies.normal, ...dependencies.updates].map(source => `input/${source}`)];
    if (isAssistantRole(role)) return `${definition.systemPrompt}\n\n# 本会话的 Input\n\n宿主为当前任务放入的材料在 \`input/\` 下，只读。使用 list 查看，使用 read 读取。`;
    const interaction = role === "voice"
      ? "# 对话方式\n\n这是连续的语音访谈。通过自然的语音对话逐步追问缺失事实、具体故事和判断依据，不暂停等待结构化问答。"
      : `# 向用户提问\n\n你可以使用 askuser，但通常只在缺少的信息或选择会实质改变当前工作、且无法从已有输入得到时使用。${role === "evaluator" ? "完成一轮真实模拟后，按照 Evaluator 的角色指令用一次 askuser，请 Creator 一起看几处真正需要他拿捏的细节；这不是例行确认。" : ""}一次只调用一个 askuser，把相关问题合并到 questions 数组；如果提供 options，每个 option 必须是只有一个单行 \`content\` 字段的对象；选项之外用户界面总会提供自由回答框。调用后本轮立即结束，不要继续调用工具或写成果；用户下一条普通消息就是回答。不要用它做进度汇报或把内部标准交给用户决定。`;
    return `${definition.systemPrompt}\n\n# 本 Agent 的 Input\n\n你有且只有这些输入文件夹：${folders.map(folder => `\`${folder}/\``).join("、")}。\n\`input/manual/\` 是用户为当前 Product 上传的公共文件；其余目录是上游 Agent 的实时只读 output projection。使用 list 查看，使用 read 读取。不要要求用户复制或转发上游文件，也不要尝试修改上游目录。\n\n${interaction}`;
  }
  async start(id: string, input: string | AgentMessage[], images: string[] = []): Promise<void> {
    const message = typeof input === "string" ? input : input.map(messageText).join("\n\n");
    if (!message.trim() || message.length > 100000) throw new Error("Provide a message of 1–100000 characters");
    if (this.active.has(id)) throw new Error("This conversation is already running");
    const controller = new AbortController();
    const runId = `run_${randomUUID()}`;
    this.active.set(id, controller);
    this.runIds.set(id, runId);
    try {
      await this.store.update(id, s => { if (s.title === s.role) s.title = message.trim().slice(0, 60); s.turn++; s.status = "running"; s.lastRunAt = new Date().toISOString(); delete s.error; delete s.activeTool; });
    } catch (error) { this.active.delete(id); throw error; }
    this.emit(id, "state");
    this.emit(id, "voice.run_started", { runId });
    const run = withLangfuseTurn("studio.turn", message, () => this.main(id, input, controller, images), this.traceIdentifiers()).catch(error => {
      if (!controller.signal.aborted) this.emit(id, "error", { message: safeError(error) });
    });
    this.runs.set(id, run);
    void run.finally(() => { if (this.runs.get(id) === run) this.runs.delete(id); });
  }
  stop(id: string): void { this.active.get(id)?.abort(); }
  isRunning(id: string): boolean { return this.active.has(id); }  /**
   * Steer a running turn: the message joins the context before the next model
   * call and the turn goes on. Returns false when no turn is running, or when
   * it has not reached its model loop yet; the caller then starts a new turn.
   */
  steer(id: string, input: string | AgentMessage, images: string[] = []): boolean {
    const agent = this.liveAgents.get(id);
    if (!agent || (typeof input === "string" && !input.trim())) return false;
    agent.steer(typeof input !== "string" ? input : images.length ? userMessage(input, images) : { role: "user", content: input, timestamp: Date.now() });
    return true;
  }
  /**
   * Deliver a message: it steers the running turn or starts one. The check and the act share one
   * synchronous step, so a message is never refused, never lost, and never starts a second run.
   * Until the run's model loop can take it (or while it compacts) the message waits and joins after.
   */
  async send(id: string, message: AgentMessage, client: ClientAttributes = WEB): Promise<{ queued: boolean; runId: string }> {
    this.clients.set(id, client);
    if (!this.active.has(id)) { await this.start(id, [message]); return { queued: false, runId: this.runIds.get(id)! }; }
    const agent = this.liveAgents.get(id);
    if (agent && !this.compacting.has(id)) { this.steered.set(id, (this.steered.get(id) ?? new Set()).add(message)); agent.steer(message); }
    else this.held.set(id, [...(this.held.get(id) ?? []), message]);
    return { queued: true, runId: this.runIds.get(id)! };
  }
  /** Gives the model loop what waited for it. */
  private release(id: string): void {
    const agent = this.liveAgents.get(id);
    if (agent && !this.compacting.has(id)) for (const message of this.take(id) ?? []) agent.steer(message);
  }
  private take(id: string): AgentMessage[] | undefined {
    const waiting = this.held.get(id);
    this.held.delete(id);
    return waiting?.length ? waiting : undefined;
  }
  triggerScribeVoiceEvidence(id: string, evidence: AgentMessage[]): void {
    if (!evidence.length) return;
    const previous = this.scribeRuns.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      if (this.closing) return;
      await this.runScribeVoiceEvidence(id, evidence);
    });
    this.scribeRuns.set(id, run);
    void run.then(
      () => { if (this.scribeRuns.get(id) === run) this.scribeRuns.delete(id); },
      error => {
        if (this.scribeRuns.get(id) === run) this.scribeRuns.delete(id);
        if (!this.closing) {
          const message = safeError(error);
          void this.store.update(id, state => { state.error = message; }).catch(() => undefined);
          this.emit(id, "scribe_error", { message });
        }
      },
    );
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.active.values()) controller.abort();
    for (const controller of this.scribeControllers) controller.abort();
    await Promise.allSettled([...this.runs.values(), ...this.scribeRuns.values()]);
  }

  private async runScribeVoiceEvidence(id: string, evidence: AgentMessage[]): Promise<void> {
    const controller = new AbortController();
    this.scribeControllers.add(controller);
    try {
      const scribePrompt = await readFile(fileURLToPath(new URL("voice/SCRIBE.md", new URL("../../prompts/factory-agents/", import.meta.url))), "utf8");
      const changed = () => this.emit(id, "files");
      const current = await this.store.get(id);
      await withLangfuseTurn("studio.turn", evidence, () => this.run(id, scribePrompt, current.scribeContext ?? [], JSON.stringify({ turn: evidence }, null, 2), fileTools(this.store, id, { changed }), controller, "scribe"), this.traceIdentifiers());
    } finally {
      this.scribeControllers.delete(controller);
    }
  }
  private async main(id: string, message: string | AgentMessage[], controller: AbortController, images: string[] = []): Promise<void> {
    let system = "";
    let ended: "completed" | "interrupted" | "failed" = "failed";
    try {
      const s = await this.store.get(id);
      const definition = await this.store.definition(s.role);
      system = await this.prompt(s.role, definition);
      if (s.role === "generation") system += `\n宿主提供的目标 Runtime 工具：内建 hatch.web_search；有 Knowledge 时启用 hatch.file_search。额外声明：${this.env.HATCH_FACTORY_TARGET_TOOLS_JSON ?? "[]"}。外部连接的实际可用性由现有 Registry/Runtime 验证。当前 Product 已由宿主固定；corpus_upload 会发布到它，不要查找、选择或创建 Product。`;
      if (s.role === "voice" && s.assistantTaskId) system += `\n\n# 本次访谈由 Hatch 助理发起\n\n这是文字对话，不是语音。专家在手机或 Studio 里打字回复，你的每条回复都会原样发给他。专家只知道自己在和 Hatch 助理说话：不要自我介绍，不要提"访谈 Agent"或任何内部角色，也不要提工具、文件路径或目录，直接接着聊。搜索失败不等于没搜到：失败了就说没搜成，不要说"搜了没找到"。input/manual/ 里是专家的资料：资料里有的绝不再问，最值得问的是资料和他本人之间的落差。专家说不算数的来源不要采用。开始时先用 update_todo 读已有大纲：还有没聊完的就接着聊，不重列，也不再打招呼和介绍，一句话说还剩哪几件，直接问；没有或助理交代了新目标，就列出这次的大纲：三到五件要聊清楚的事，围绕助理交代的目标和这位专家本人。第一条回复用一句话告诉专家这次要聊哪几件事、聊完他能得到什么，再问第一个问题。之后按大纲推进，一件聊透就在 update_todo 里标完成，并自然地转到下一件，让专家知道走到哪了。一次只问一个问题，一到两句话；先接住他说的，再追问具体的故事、数字和判断依据。大纲都聊完了就调用 handoff_to_assistant 交回助理。你只负责访谈，后面还有助理在：专家要你查资料、搜索、写东西、派谁去做事，问系统或工具的问题，或想停，都不要自己回答，也不要说做不了，直接调用 handoff_to_assistant。专家反复绕开你的问题，也交回，不要换个角度再问。不用 Markdown，发的是纯文字。专家发的图片你能直接看到。`;
      if (s.role === "evaluator") system += `\n当前 Product 已由宿主固定；hatch_tool 只会运行它，不要查找或选择 Product。启动时如需 brief_answers，从案例中选择客户可见的信息作答；不能泄露评分标准。当前 Brief 字段：${JSON.stringify(this.store.scope?.briefSpec ?? null)}。`;
      const changed = () => this.emit(id, "files");
      const todosChanged = () => this.emit(id, "todos");
      const tools = declareTools(await factoryAgentTools({
        store: this.store,
        id,
        definition,
        signal: controller.signal,
        changed,
        todosChanged,
        env: this.env,
        extraTools: await this.options.extraTools?.(s, controller.signal, changed),
        grantedTools: this.options.grantedTools?.(s),
        withheldTools: await this.options.withheldTools?.(s),
      }), this.options.toolSupport ?? studioToolSupport, () => this.clientOf(id).client);
      const messageCount = s.messages.length;
      let history = s.context;
      let input = message;
      let attachedImages = images;
      // Messages that arrived while the loop could not take them start the next pass of this same run.
      for (;;) {
        const visibleMessages = await this.run(id, system, history, input, tools, controller, "visible", attachedImages);
        const waiting = controller.signal.aborted ? undefined : this.take(id);
        if (waiting) { history = (await this.store.get(id)).context; input = waiting; attachedImages = []; continue; }
        if (s.role === "voice" && !controller.signal.aborted && !hasTrailingAskUser(visibleMessages)) {
          const latest = await this.store.get(id);
          const evidence = latest.messages.slice(messageCount);
          this.triggerScribeVoiceEvidence(id, evidence);
        }
        await this.store.update(id, state => { state.status = controller.signal.aborted ? "interrupted" : "completed"; delete state.activeTool; });
        const late = controller.signal.aborted ? undefined : this.take(id);
        if (!late) break;
        await this.store.update(id, state => { state.status = "running"; });
        history = (await this.store.get(id)).context; input = late; attachedImages = [];
      }
      ended = controller.signal.aborted ? "interrupted" : "completed";
      this.emit(id, controller.signal.aborted ? "voice.run_interrupted" : "voice.run_completed", { runId: this.runIds.get(id) });
    } catch (error) {
      // Messages acknowledged to clients stay in history even when the run did not take them.
      const lost = [...this.take(id) ?? [], ...this.steered.get(id) ?? []];
      for (const message of lost) await this.commit(id, () => this.store.update(id, state => { state.messages.push(message); state.context.push(message); })).catch(() => undefined);
      ended = controller.signal.aborted ? "interrupted" : "failed";
      await this.store.update(id, s => {
        if (controller.signal.aborted) {
          // A user stop is a normal terminal state, not an error notice.
          s.status = "interrupted";
          delete s.error;
        } else {
          s.status = "failed";
          s.error = safeError(error);
        }
        delete s.activeTool;
      });
      this.emit(id, controller.signal.aborted ? "voice.run_interrupted" : "voice.run_failed", { runId: this.runIds.get(id) });
    } finally {
      this.active.delete(id);
      this.runIds.delete(id);
      this.clients.delete(id);
      this.held.delete(id);
      this.steered.delete(id);
      this.emit(id, "run_end", { status: ended });
      this.emit(id, "state");
    }
  }
  private async run(id: string, systemPrompt: string, history: AgentMessage[], userText: string | AgentMessage[], tools: AgentTool[], controller: AbortController, channel: "visible" | "scribe" = "visible", images: string[] = []): Promise<AgentMessage[]> {
    const factory = this.options.agentFactory ?? createFactoryPiAgent;
    let turnCount = 0;
    let persistence = Promise.resolve();
    let persistenceError: unknown;
    let summarizedCount = 0;
    let summaryMessage: AgentMessage | undefined;
    const agent = factory({ env: this.env, maxTokens: 32768, initialState: { systemPrompt, messages: history, tools: traceAgentTools(tools) }, agentOptions: {
      toolExecution: "sequential",
      // askuser is a turn boundary. The tool result is persisted as a normal
      // tool result, then the next user message starts a fresh Agent turn.
      afterToolCall: async ({ toolCall }) => toolCall.name === "askuser" ? { terminate: true } : undefined,
      transformContext: async (messages, signal) => {
        const effective = summaryMessage ? [summaryMessage, ...messages.slice(summarizedCount)] : messages;
        const tokens = effective.reduce((sum, entry) => sum + estimateTokens(entry), 0);
        const forModel = async (current: AgentMessage[]) => {
          const hydrated = await hydrateImages(current, async file => (await this.store.read(id, file)).bytes);
          if (channel !== "visible") return hydrated;
          // After all history, rebuilt for every call and never stored: the cached prefix stays intact.
          const tail = [await this.options.liveState?.(id), renderSystemReminder(this.clientOf(id))].filter(Boolean).join("\n\n");
          return [...hydrated, { role: "user" as const, content: tail, timestamp: Date.now() }];
        };
        if (tokens < 165000) return forModel(effective);
        this.emit(id, "compacting");
        this.compacting.add(id);
        try {
        // Retain recent messages, cutting before an assistant/tool-call group.
        let cut = Math.max(summarizedCount, messages.length - 12);
        while (cut > summarizedCount && messages[cut]?.role === "toolResult") cut--;
        if (cut <= summarizedCount) throw new Error("当前上下文过大；请缩小单份工具输出或输入后继续");
        const prefix = [...(summaryMessage ? [summaryMessage] : []), ...messages.slice(summarizedCount, cut)];
        const { models, model } = createFactoryPiModels({ env: this.env, maxTokens: 8000 });
        const summary = await generateSummaryWithUsage(imagesAsText(prefix), models, model, 10000, signal, "Preserve current user requirements, decisions, unresolved work, exact file paths and real upload/run receipts. Source files remain readable; never invent successful operations.");
        if (!summary.ok) throw summary.error;
        summaryMessage = createCompactionSummaryMessage(summary.value.text, tokens, new Date().toISOString());
        summarizedCount = cut;
        const compacted = [summaryMessage, ...messages.slice(cut)];
        await persistence;
        await this.store.update(id, state => { state.context = compacted; });
        return forModel(compacted);
        } finally { this.compacting.delete(id); this.release(id); }
      }
    } });
    if (channel === "visible") { this.liveAgents.set(id, agent); this.release(id); }
    const abort = () => agent.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("运行达到时间预算，可检查已有文件后继续")), this.options.deadlineMs ?? 1800000);
    const unsubscribe = agent.subscribe(event => {
      if (event.type === "turn_start" && ++turnCount > (this.options.maxTurns ?? 80)) controller.abort(new Error("运行达到工具轮次预算，可检查已有文件后继续"));
      if (event.type === "message_end") {
        // In stream order with the deltas, so clients settle this reply before the next one streams.
        if (channel === "visible") this.emit(id, "message_end");
        persistence = persistence.then(async () => {
          if (channel === "visible") {
            await this.commit(id, () => this.store.update(id, s => { s.messages.push(event.message); s.context.push(event.message); }));
            this.steered.get(id)?.delete(event.message);
          } else await this.store.update(id, s => { s.scribeContext ??= []; s.scribeContext.push(event.message); });
        }).catch(error => { persistenceError = error; controller.abort(); });
      }
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (channel === "visible" && update.type === "text_delta") { this.emit(id, "delta", { text: update.delta }); this.emit(id, "voice.delta", { runId: this.runIds.get(id), text: update.delta }); }
        if (channel === "visible" && update.type === "thinking_start") this.emit(id, "thinking");
      }
      if (event.type === "tool_execution_start") {
        if (channel === "visible") persistence = persistence.then(() => this.store.update(id, s => { s.activeTool = event.toolName; }));
        if (channel === "visible") { this.emit(id, "tool", { name: event.toolName }); this.emit(id, "voice.tool", { runId: this.runIds.get(id) }); }
      }
      if (channel === "visible" && event.type === "tool_execution_end") { this.emit(id, "tool_end", { name: event.toolName, isError: event.isError }); this.emit(id, "voice.tool_end", { runId: this.runIds.get(id) }); }
    });
    try {
      controller.signal.throwIfAborted();
      await (typeof userText !== "string" ? agent.prompt(userText) : images.length ? agent.prompt(userMessage(userText, images)) : agent.prompt(userText));
      // A message steered after the loop's last poll is still queued: run it. The agent leaves the live set in
      // the same step as the last empty check, so a later message waits for the next pass instead of vanishing.
      while (agent.hasQueuedMessages() && !controller.signal.aborted) await agent.continue();
      if (this.liveAgents.get(id) === agent) this.liveAgents.delete(id);
      await persistence;
      if (persistenceError) throw persistenceError;
      controller.signal.throwIfAborted();
      const last = agent.state.messages.at(-1);
      if (last?.role === "assistant" && ["error", "aborted", "length"].includes(last.stopReason)) throw new Error(last.errorMessage || `Model stopped: ${last.stopReason}`);
      return agent.state.messages;
    } finally { if (this.liveAgents.get(id) === agent) this.liveAgents.delete(id); clearTimeout(timer); unsubscribe(); controller.signal.removeEventListener("abort", abort); await persistence; }
  }
}

function hasTrailingAskUser(messages: AgentMessage[]): boolean {
  let latestUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      latestUser = index;
      break;
    }
  }
  return messages.slice(latestUser + 1).some(message => message.role === "assistant" && Array.isArray(message.content) && message.content.some(block => block.type === "toolCall" && block.name === "askuser"));
}

export function safeError(error: unknown): string {
  const provider = classifyFactoryProviderFailure(error);
  if (provider) return provider.message;
  return (error instanceof Error ? error.message : String(error)).replace(/\b(?:sk-|tvly-|fc-)[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 1000);
}
