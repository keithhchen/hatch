import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { hydrateImages, imagesAsText, messageText, userMessage } from "./imageRefs.js";
import type { Agent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { BackgroundCompactor, CompactionStrategy, newCompactionId, policyFor, type CompactionAdapter, type CompactionOutcome, type CompactionPolicy, type CompactionRequest, type SummarizeInput } from "../compactionStrategy.js";
import { describePiMessage, piSummaryMessage, prunePiMessage, summarizeWithPi } from "../piCompaction.js";
import { createFactoryLlmModel, createFactoryPiAgent, createFactoryPiModels, type FactoryPiAgentOptions } from "../creatorLearning/factoryPi.js";
import { failures } from "../errors/failures.js";
import { UpstreamError } from "../errors/upstream.js";
import type { RunFailure } from "./runFailure.js";
import { INPUT_ROLES, RUN_HEARTBEAT_MS, WorkbenchStore, isAssistantRole, itemIdOf, settleMessage, type AgentDefinitionSource, type AnyRole, type Session } from "./store.js";
import { factoryAgentTools } from "./factoryTools.js";
import { provideFormReference } from "../formPages/tools.js";
import { fileTools } from "./tools.js";
import { traceAgentTools, withLangfuseTurn, type LangfuseTurnIdentifiers } from "../langfuse.js";
import { renderSystemReminder, type ClientAttributes } from "../surfaces/contract.js";
import type { Journal } from "./journal.js";
import { declareTools, studioToolSupport, type ClientSupport } from "./toolSurface.js";
import type { LlmProfile } from "../llmProfiles.js";
import type { ModelRole, ModelRoleResolver } from "../modelRoles.js";
import { log } from "../observability/log.js";
import { currentContext } from "../observability/context.js";
import { studioAttribution, usageSink, type UsageRecorder, type UsageSink } from "../usage/usage.js";
import { UsageCapExceeded, type UsageCap } from "../usage/usageCap.js";

const WEB: ClientAttributes = { client: "web" };

export type WorkbenchRuntimeOptions = {
  /** Where the model is chosen: read at the start of each Run, which keeps that model to its end. */
  models: ModelRoleResolver;
  /** The role this workspace's Agents run as: `factory` for a Product workspace, `worker` for the Assistant's. */
  role: Extract<ModelRole, "factory" | "worker">;
  /** What holds the model's API key and the tools' settings; the process's own when absent. */
  env?: NodeJS.ProcessEnv;
  agentFactory?: (options: FactoryPiAgentOptions) => Agent;
  extraTools?: (session: Session, signal: AbortSignal, changed: () => void) => Promise<AgentTool[]>;
  withheldTools?: (session: Session) => Promise<string[]>;
  /** Which clients may run each tool. Defaults to what Studio declares. */
  toolSupport?: ClientSupport;
  /** Where public events are recorded from the first Run, and where a message is persisted together with its event. */
  journal?: Journal;
  /** Whose Studio usage this workspace's model calls are, and where they are recorded. */
  usage?: { recorder: UsageRecorder; accountId: string; /** A Run is not started when the account has spent its month. */ cap?: UsageCap };
  deadlineMs?: number;
  maxTurns?: number;
  /** One strategy with Chat; this is Studio's adapter. Tests inject a test-only summarizer and a small window. */
  compaction?: { summarize?: (input: SummarizeInput<AgentMessage>) => Promise<string>; contextWindow?: number; policy?: Partial<CompactionPolicy>; now?: () => number };
};

/** Studio output budget passed to the factory model; the policy reserves it. */
const OUTPUT_TOKENS = 32768;

/** The session already holds a message under this item id: a repeat, not a new message. */
export class MessageAlreadyAccepted extends Error { constructor() { super("This message was already accepted"); } }

export class WorkbenchRuntime {
  readonly events = new EventEmitter();
  private active = new Map<string, AbortController>();
  private runs = new Map<string, Promise<void>>();
  private scribeRuns = new Map<string, Promise<void>>();
  private scribeControllers = new Set<AbortController>();
  private runIds = new Map<string, string>();
  /** The API key behind the request that started each session's latest Run, if any: its calls are Studio API usage. */
  private runKeys = new Map<string, string>();
  private liveAgents = new Map<string, Agent>();
  /** Which queued item ids this run has taken (started with or steered in). The queue itself lives on the session. */
  private delivered = new Map<string, Set<string>>();
  private compacting = new Set<string>();
  private background = new BackgroundCompactor<string>();
  /** When each conversation's prefix last reached the provider: the cache is alive for the policy's ttl after. */
  private touched = new Map<string, number>();
  private readonly strategies = new Map<string, CompactionStrategy<AgentMessage>>();
  /** The client of the latest message of each running conversation. */
  private clients = new Map<string, ClientAttributes>();
  private closing = false;
  private readonly env: NodeJS.ProcessEnv;
  constructor(readonly store: WorkbenchStore, private options: WorkbenchRuntimeOptions) {
    this.env = options.env ?? process.env;
  }
  private profile(): Promise<LlmProfile> { return this.options.models.resolve(this.options.role); }
  private traceIdentifiers(): LangfuseTurnIdentifiers | undefined {
    const scope = this.store.scope;
    return scope ? { productId: scope.productId, userId: scope.creatorId } : undefined;
  }
  /** Each model call of a session's Run counts as the Expert's Studio usage. */
  private usageFor(id: string): UsageSink | undefined {
    const { usage } = this.options;
    const productId = this.store.scope?.productId;
    return usage && usageSink(usage.recorder, studioAttribution(usage.accountId, this.runKeys.get(id), { ...(productId ? { productId } : {}), ...(this.runIds.get(id) ? { runId: this.runIds.get(id)! } : {}) }), log);
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
    const folders = ["input/manual", ...(isAssistantRole(role) ? [] : INPUT_ROLES[role]).map(source => `input/${source}`)];
    if (isAssistantRole(role)) return `${definition.systemPrompt}\n\n# 本会话的 Input\n\n宿主为当前任务放入的材料在 \`input/\` 下，只读。使用 list 查看，使用 read 读取。`;
    const interaction = role === "voice"
      ? ""
      : `# 向用户提问\n\n你可以使用 askuser，但通常只在缺少的信息或选择会实质改变当前工作、且无法从已有输入得到时使用。${role === "evaluator" ? "完成一轮真实模拟后，按照 Evaluator 的角色指令用一次 askuser，请 Creator 一起看几处真正需要他拿捏的细节；这不是例行确认。" : ""}一次只调用一个 askuser，把相关问题合并到 questions 数组；如果提供 options，每个 option 必须是只有一个单行 \`content\` 字段的对象；选项之外用户界面总会提供自由回答框。调用后本轮立即结束，不要继续调用工具或写成果；用户下一条普通消息就是回答。不要用它做进度汇报或把内部标准交给用户决定。`;
    return `${definition.systemPrompt}\n\n# 本 Agent 的 Input\n\n你有且只有这些输入文件夹：${folders.map(folder => `\`${folder}/\``).join("、")}。\n\`input/manual/\` 是用户为当前 Product 上传的公共文件；其余目录是上游 Agent 的实时只读 output projection。使用 list 查看，使用 read 读取。不要要求用户复制或转发上游文件，也不要尝试修改上游目录。\n\n${interaction}`;
  }
  async start(id: string, input: string | AgentMessage[], images: string[] = []): Promise<void> {
    const message = typeof input === "string" ? input : input.map(messageText).join("\n\n");
    if (!message.trim() || message.length > 100000) throw new Error("Provide a message of 1–100000 characters");
    if (this.active.has(id)) throw new Error("This conversation is already running");
    // Only a new Run is asked; steering into a running one goes through send() and never reaches here.
    await this.options.usage?.cap?.assertWithinCap(this.options.usage.accountId);
    const controller = new AbortController();
    const runId = `run_${randomUUID()}`;
    this.active.set(id, controller);
    this.runIds.set(id, runId);
    const apiKeyId = currentContext()?.api_key_id;
    if (apiKeyId) this.runKeys.set(id, apiKeyId); else this.runKeys.delete(id);
    try {
      // The run is already ours; background compaction yields and ends before the message proceeds.
      await this.background.preempt(id);
      await this.store.update(id, s => { if (s.title === s.role) s.title = message.trim().slice(0, 60); s.turn++; s.status = "running"; s.lastRunAt = new Date().toISOString(); delete s.error; delete s.errorCode; delete s.errorRef; delete s.activeTool; });
    } catch (error) { this.active.delete(id); throw error; }
    this.emit(id, "state");
    this.emit(id, "voice.run_started", { runId });
    const beat = setInterval(() => void this.store.update(id, () => undefined).catch(() => undefined), RUN_HEARTBEAT_MS);
    beat.unref();
    const run = withLangfuseTurn("studio.turn", message, () => this.main(id, input, controller, images), this.traceIdentifiers()).catch(error => {
      if (!controller.signal.aborted) this.emit(id, "error", { message: safeError(error) });
    });
    this.runs.set(id, run);
    void run.finally(() => { clearInterval(beat); if (this.runs.get(id) === run) this.runs.delete(id); });
  }
  stop(id: string): void { this.active.get(id)?.abort(); }
  isRunning(id: string): boolean { return this.active.has(id); }
  /**
   * Deliver a message. It is written to the session's queue first, so it survives a crash and a replay finds it;
   * only then does it start a run or reach the running one. The check and the act share one synchronous step,
   * so a message never starts a second run. A message under an item id the session already holds is refused.
   */
  async send(id: string, message: AgentMessage, client: ClientAttributes = WEB): Promise<{ queued: boolean; runId: string }> {
    const text = messageText(message);
    if (!text.trim() || text.length > 100000) throw new Error("Provide a message of 1–100000 characters");
    const queue = await this.store.enqueue(id, message);
    if (!queue) throw new MessageAlreadyAccepted();
    this.clients.set(id, client);
    if (this.active.has(id)) { this.release(id); return { queued: true, runId: this.runIds.get(id)! }; }
    try { await this.start(id, queue.filter(queued => this.claim(id, queued))); } catch (error) {
      this.delivered.delete(id);
      await this.store.dequeue(id, itemIdOf(message)!).catch(() => undefined);
      throw error;
    }
    return { queued: false, runId: this.runIds.get(id)! };
  }
  private claim(id: string, message: AgentMessage): boolean {
    const taken = this.delivered.get(id) ?? new Set<string>();
    this.delivered.set(id, taken);
    const item = itemIdOf(message)!;
    return !taken.has(item) && !!taken.add(item);
  }
  /** What the session's queue holds that this run has not taken. */
  private async waiting(id: string): Promise<AgentMessage[]> { return ((await this.store.get(id)).queue ?? []).filter(message => !this.delivered.get(id)?.has(itemIdOf(message)!)); }
  /** Gives the model loop what waited for it: before its loop started, or during compaction. */
  private release(id: string): void {
    void (async () => {
      for (const message of await this.waiting(id)) {
        const agent = this.liveAgents.get(id);
        if (agent && !this.compacting.has(id) && this.claim(id, message)) agent.steer(message);
      }
    })().catch(() => undefined);
  }
  /** Takes what is queued and untaken, for the same run's next pass. */
  private async take(id: string): Promise<AgentMessage[] | undefined> {
    const taken = (await this.waiting(id)).filter(message => this.claim(id, message));
    return taken.length ? taken : undefined;
  }
  /** A message that landed as the run ended starts the next one. */
  private async resume(id: string): Promise<void> {
    const waiting = await this.waiting(id);
    if (!waiting.length || this.active.has(id) || this.closing) return;
    try { await this.start(id, waiting.filter(message => this.claim(id, message))); } catch (error) {
      // A message that cannot start its Run is never left quietly queued: the session says why, and the message stays for the next send.
      this.delivered.delete(id);
      if (!(error instanceof UsageCapExceeded)) throw error;
      await this.store.update(id, s => { s.status = "failed"; s.error = error.message; s.errorCode = error.code; delete s.errorRef; });
      this.emit(id, "state");
    }
  }
  /** Studio has no memory layer for conversations, so the strategy gets no CompactionMemory. */
  private strategy(profile: LlmProfile): CompactionStrategy<AgentMessage> {
    const cached = this.strategies.get(profile.name);
    if (cached) return cached;
    const override = this.options.compaction;
    const window = override?.contextWindow ?? createFactoryLlmModel({ profile, env: this.env, maxTokens: 8000 }).contextWindow;
    const adapter: CompactionAdapter<AgentMessage> = { describe: describePiMessage, prune: prunePiMessage, summaryMessage: piSummaryMessage,
      summarize: override?.summarize ?? summarizeWithPi(message => imagesAsText([message])[0]!, () => createFactoryPiModels({ profile, env: this.env, maxTokens: 8000 })) };
    const strategy = new CompactionStrategy(adapter, { ...policyFor(window, { outputTokens: OUTPUT_TOKENS }), ...override?.policy });
    this.strategies.set(profile.name, strategy);
    return strategy;
  }
  private now(): number { return this.options.compaction?.now?.() ?? Date.now(); }
  /** One compaction, visible as `compacting` then `compacted` (both journaled with the same id); degraded also says so. */
  private async compactNow(id: string, messages: AgentMessage[], signal: AbortSignal, profile: LlmProfile, extra: Partial<CompactionRequest> = {}): Promise<CompactionOutcome<AgentMessage>> {
    const strategy = this.strategy(profile);
    const compactionId = newCompactionId();
    if (extra.force || strategy.tokensOf(messages) >= strategy.policy.trigger) this.emit(id, "compacting", { compactionId });
    const outcome = await strategy.compact(messages, { now: this.now(), cacheTouchedAt: this.touched.get(id), signal, usage: this.usageFor(id), ...extra });
    if (outcome.kind !== "none") this.emit(id, "compacted", { compactionId, kind: outcome.kind, degraded: outcome.kind === "degraded", dropped: outcome.kind === "degraded" ? outcome.dropped : 0 });
    if (outcome.kind === "degraded") this.emit(id, "compaction_degraded", { compactionId, dropped: outcome.dropped, note: describePiMessage(outcome.messages[0]!).text });
    return outcome;
  }
  /** After the reply, with no live agent: it applies only if nothing was added meanwhile, and a new message preempts it. */
  private scheduleBackground(id: string): void {
    void (async () => {
      if (this.closing) return;
      const profile = await this.profile();
      const strategy = this.strategy(profile);
      const tokens = strategy.tokensOf((await this.store.get(id)).context);
      const remaining = strategy.policy.cacheTtlMs - (this.now() - (this.touched.get(id) ?? Number.NEGATIVE_INFINITY));
      // Below the summary trigger, pruning waits for the provider cache to expire.
      const delay = tokens < strategy.policy.trigger && remaining > 0 ? remaining + 1 : 0;
      this.background.schedule(id, async signal => {
        if (this.active.has(id)) return;
        const context = (await this.store.get(id)).context;
        const outcome = await this.compactNow(id, context, signal, profile);
        if (outcome.kind === "none") return;
        await this.store.update(id, state => { if (!this.active.has(id) && state.context.length === context.length) state.context = outcome.messages; });
      }, delay);
    })().catch(() => undefined);
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
  /** Resolves when the Runs under way have ended. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.runs.values(), ...this.scribeRuns.values()]);
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.active.values()) controller.abort();
    await this.background.drain();
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
    let failure: RunFailure | undefined;
    try {
      const s = await this.store.get(id);
      const definition = await this.store.definition(s.role);
      system = await this.prompt(s.role, definition);
      if (s.role === "generation") system += `\n宿主提供的目标 Runtime 工具：内建 hatch.web_search。额外声明：${this.env.HATCH_FACTORY_TARGET_TOOLS_JSON ?? "[]"}。外部连接的实际可用性由现有 Registry/Runtime 验证。当前 Product 已由宿主固定；corpus_upload 会发布到它，不要查找、选择或创建 Product。`;
      if (s.role === "voice") system += `\n\n${await readFile(fileURLToPath(new URL("../../prompts/assistant/INTERVIEW_DONE.md", import.meta.url)), "utf8")}`;
      if (s.role === "voice" && s.assistantTaskId) system += `\n\n${await readFile(fileURLToPath(new URL("voice/ASSISTANT_INTERVIEW.md", new URL("../../prompts/factory-agents/", import.meta.url))), "utf8")}`;
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
        withheldTools: await this.options.withheldTools?.(s),
      }), this.options.toolSupport ?? studioToolSupport, () => this.clientOf(id).client);
      if (tools.some(tool => tool.name === "publish_form")) await provideFormReference(this.store, id);
      if (tools.some(tool => tool.name === "publish_form")) system += `\n\n${await readFile(fileURLToPath(new URL("voice/FORM_PAGE.md", new URL("../../prompts/factory-agents/", import.meta.url))), "utf8")}`;
      const messageCount = s.messages.length;
      let history = s.context;
      let input = message;
      let attachedImages = images;
      // Messages that arrived while the loop could not take them start the next pass of this same run.
      for (;;) {
        const visibleMessages = await this.run(id, system, history, input, tools, controller, "visible", attachedImages);
        const waiting = controller.signal.aborted ? undefined : await this.take(id);
        if (waiting) { history = (await this.store.get(id)).context; input = waiting; attachedImages = []; continue; }
        if (s.role === "voice" && !controller.signal.aborted && !hasTrailingAskUser(visibleMessages)) {
          const latest = await this.store.get(id);
          const evidence = latest.messages.slice(messageCount);
          this.triggerScribeVoiceEvidence(id, evidence);
        }
        await this.store.update(id, state => { state.status = controller.signal.aborted ? "interrupted" : "completed"; delete state.activeTool; });
        break;
      }
      ended = controller.signal.aborted ? "interrupted" : "completed";
      this.emit(id, controller.signal.aborted ? "voice.run_interrupted" : "voice.run_completed", { runId: this.runIds.get(id) });
    } catch (error) {
      // Messages acknowledged to clients stay in history even when the run did not take them.
      for (const message of (await this.store.get(id).catch(() => undefined))?.queue ?? []) await this.commit(id, () => this.store.update(id, state => settleMessage(state, message))).catch(() => undefined);
      ended = controller.signal.aborted ? "interrupted" : "failed";
      if (!controller.signal.aborted) failure = failures.translate(error, { run: this.runIds.get(id), session: id });
      await this.store.update(id, s => {
        if (!failure) {
          // A user stop is a normal terminal state, not an error notice.
          s.status = "interrupted";
          delete s.error; delete s.errorCode; delete s.errorRef;
        } else {
          s.status = "failed";
          s.error = failure.message; s.errorCode = failure.code; s.errorRef = failure.reference;
        }
        delete s.activeTool;
      });
      this.emit(id, controller.signal.aborted ? "voice.run_interrupted" : "voice.run_failed", { runId: this.runIds.get(id) });
    } finally {
      this.active.delete(id);
      if (ended === "completed") this.scheduleBackground(id);
      this.runIds.delete(id);
      this.clients.delete(id);
      this.delivered.delete(id);
      this.emit(id, "run_end", { status: ended, ...(failure ? { error: failure } : {}) });
      this.emit(id, "state");
      if (ended === "completed") void this.resume(id).catch(() => undefined);
    }
  }
  private async run(id: string, systemPrompt: string, history: AgentMessage[], userText: string | AgentMessage[], tools: AgentTool[], controller: AbortController, channel: "visible" | "scribe" = "visible", images: string[] = []): Promise<AgentMessage[]> {
    const factory = this.options.agentFactory ?? createFactoryPiAgent;
    // The Run keeps the model it began with, whatever the database says later.
    const profile = await this.profile();
    let turnCount = 0;
    let persistence = Promise.resolve();
    let persistenceError: unknown;
    // What stands in for the first `base` messages of the agent's transcript, once they were compacted.
    let replaced: AgentMessage[] = [];
    let base = 0;
    if (channel === "visible") {
      // Fallback before a turn: a conversation already over the trigger is compacted now.
      const early = await this.compactNow(id, history, controller.signal, profile);
      if (early.kind !== "none") { history = early.messages; await this.store.update(id, state => { state.context = history; }); }
    }
    const agent = factory({ profile, env: this.env, maxTokens: 32768, initialState: { systemPrompt, messages: history, tools: traceAgentTools(tools) }, agentOptions: {
      toolExecution: "sequential",
      // askuser is a turn boundary. The tool result is persisted as a normal
      // tool result, then the next user message starts a fresh Agent turn.
      afterToolCall: async ({ toolCall }) => toolCall.name === "askuser" ? { terminate: true } : undefined,
      transformContext: async (messages, signal) => {
        const forModel = async (current: AgentMessage[]) => {
          const hydrated = await hydrateImages(current, async file => (await this.store.read(id, file)).bytes);
          if (channel !== "visible") return hydrated;
          // After all history, rebuilt for every call and never stored: the cached prefix stays intact.
          const tail = renderSystemReminder(this.clientOf(id));
          return [...hydrated, { role: "user" as const, content: tail, timestamp: Date.now() }];
        };
        const effective = [...replaced, ...messages.slice(base)];
        if (channel !== "visible") return forModel(effective);
        this.compacting.add(id);
        try {
          // Between tool steps: the same strategy, with the cache clock of the previous model call.
          const outcome = await this.compactNow(id, effective, signal ?? controller.signal, profile);
          this.touched.set(id, this.now());
          if (outcome.kind === "none") return forModel(effective);
          // The tail is the same message objects as before, so what was replaced is everything in front of it.
          let kept = 0;
          while (kept < messages.length - base && outcome.messages.at(-1 - kept) === effective.at(-1 - kept)) kept++;
          replaced = outcome.messages.slice(0, outcome.messages.length - kept);
          base = messages.length - kept;
          await persistence;
          await this.store.update(id, state => { state.context = outcome.messages; });
          return forModel(outcome.messages);
        } finally { this.compacting.delete(id); this.release(id); }
      }
    } });
    if (channel === "visible") { this.liveAgents.set(id, agent); this.release(id); }
    const abort = () => agent.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("运行达到时间预算，可检查已有文件后继续")), this.options.deadlineMs ?? 1800000);
    const unsubscribe = agent.subscribe(event => {
      if (event.type === "turn_start" && ++turnCount > (this.options.maxTurns ?? 80)) controller.abort(new Error("运行达到工具轮次预算，可检查已有文件后继续"));
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.usage.totalTokens > 0) {
        void this.usageFor(id)?.({ id: `${this.runIds.get(id) ?? id}:${event.message.timestamp}`, model: event.message.model, usage: event.message.usage });
      }
      if (event.type === "message_end") {
        // In stream order with the deltas, so clients settle this reply before the next one streams.
        if (channel === "visible") this.emit(id, "message_end");
        persistence = persistence.then(async () => {
          if (channel === "visible") {
            await this.commit(id, () => this.store.update(id, s => settleMessage(s, event.message)));
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
      // A provider overflow is recovered by compacting harder and continuing, a bounded number of times.
      const strategy = this.strategy(profile);
      for (let attempt = 1; channel === "visible" && !controller.signal.aborted && attempt <= strategy.policy.maxOverflowRetries; attempt++) {
        const last = agent.state.messages.at(-1);
        if (last?.role !== "assistant" || last.stopReason !== "error" || !isContextOverflow(last, this.options.compaction?.contextWindow)) break;
        await persistence;
        const outcome = await this.compactNow(id, agent.state.messages.slice(0, -1), controller.signal, profile, { force: true, tailScale: 0.5 ** attempt });
        if (outcome.kind === "none") break;
        await this.store.update(id, state => { state.context = outcome.messages; });
        replaced = []; base = 0;
        agent.state.messages = outcome.messages;
        await agent.continue();
      }
      if (this.liveAgents.get(id) === agent) this.liveAgents.delete(id);
      await persistence;
      if (persistenceError) throw persistenceError;
      controller.signal.throwIfAborted();
      const last = agent.state.messages.at(-1);
      if (last?.role === "assistant" && ["error", "aborted", "length"].includes(last.stopReason)) throw last.stopReason === "error" ? UpstreamError.of(last.errorMessage || "Model stopped: error") : new Error(last.errorMessage || `Model stopped: ${last.stopReason}`);
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
  if (error instanceof UpstreamError) return failures.translate(error).message;
  return (error instanceof Error ? error.message : String(error)).replace(/\b(?:sk-|tvly-|fc-)[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 1000);
}
