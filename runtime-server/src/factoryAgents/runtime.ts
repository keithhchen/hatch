import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { createCompactionSummaryMessage, estimateContextTokens, estimateTokens, generateSummaryWithUsage, type Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createFactoryPiAgent, createFactoryPiModels, type FactoryPiAgentOptions } from "../creatorLearning/factoryPi.js";
import { classifyFactoryProviderFailure } from "../creatorLearning/factoryLlm.js";
import { WorkbenchStore, type AgentDefinitionSource, type Role, type Session } from "./store.js";
import { factoryAgentTools } from "./factoryTools.js";
import { fileTools } from "./tools.js";

export type WorkbenchRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  agentFactory?: (options: FactoryPiAgentOptions) => Agent;
  extraTools?: (session: Session, signal: AbortSignal, changed: () => void) => Promise<AgentTool[]>;
  deadlineMs?: number;
  maxTurns?: number;
};

export class WorkbenchRuntime {
  readonly events = new EventEmitter();
  private active = new Map<string, AbortController>();
  private runs = new Map<string, Promise<void>>();
  private runIds = new Map<string, string>();
  private readonly env: NodeJS.ProcessEnv;
  constructor(readonly store: WorkbenchStore, private options: WorkbenchRuntimeOptions = {}) {
    this.env = { HATCH_FACTORY_LLM_PROFILE: "deepseek-v4-flash", ...(options.env ?? process.env) };
  }
  emit(id: string, type: string, data: Record<string, unknown> = {}): void { this.events.emit("event", { sessionId: id, type, ...data }); }
  async prompt(role: Role, snapshot?: Awaited<ReturnType<AgentDefinitionSource["list"]>>[number]): Promise<string> {
    const definition = snapshot ?? await this.store.definition(role);
    const dependencies = definition.dependencies;
    const folders = ["input/manual", ...[...dependencies.required, ...dependencies.normal].map(source => `input/${source}`)];
    const interaction = role === "voice"
      ? "# 对话方式\n\n这是连续的语音访谈。通过自然的语音对话逐步追问缺失事实、具体故事和判断依据，不暂停等待结构化问答。"
      : "# 向用户提问\n\n你可以使用 askuser，但只在缺少的信息或选择会实质改变当前工作、且无法从已有输入得到时使用。一次只调用一个 askuser，把相关问题合并到 questions 数组；如果提供 options，每个 option 必须是只有一个单行 `content` 字段的对象；选项之外用户界面总会提供自由回答框。调用后本轮立即结束，不要继续调用工具或写成果；用户下一条普通消息就是回答。不要用它做例行确认、进度汇报或把内部标准交给用户决定。";
    return `${definition.systemPrompt}\n\n# 本 Agent 的 Input\n\n你有且只有这些输入文件夹：${folders.map(folder => `\`${folder}/\``).join("、")}。\n\`input/manual/\` 是用户为当前 Product 上传的公共文件；其余目录是上游 Agent 的实时只读 output projection。使用 list 查看，使用 read 读取。不要要求用户复制或转发上游文件，也不要尝试修改上游目录。\n\n${interaction}`;
  }
  async start(id: string, message: string): Promise<void> {
    if (!message.trim() || message.length > 100000) throw new Error("Provide a message of 1–100000 characters");
    if (this.active.has(id)) throw new Error("This conversation is already running");
    const controller = new AbortController();
    const runId = `factory_${Date.now()}_${id}`;
    this.active.set(id, controller);
    this.runIds.set(id, runId);
    try {
      await this.store.update(id, s => { if (s.title === s.role) s.title = message.trim().slice(0, 60); s.turn++; s.status = "running"; s.lastRunAt = new Date().toISOString(); delete s.error; delete s.activeTool; });
    } catch (error) { this.active.delete(id); throw error; }
    this.emit(id, "state");
    this.emit(id, "voice.run_started", { runId });
    const run = this.main(id, message, controller).catch(error => {
      if (!controller.signal.aborted) this.emit(id, "error", { message: safeError(error) });
    });
    this.runs.set(id, run);
    void run.finally(() => { if (this.runs.get(id) === run) this.runs.delete(id); });
  }
  stop(id: string): void { this.active.get(id)?.abort(); }
  async scribeVoiceEvidence(id: string, evidence: AgentMessage[]): Promise<void> {
    if (!evidence.length) return;
    if (this.active.has(id)) throw new Error("This conversation is already running");
    const controller = new AbortController();
    this.active.set(id, controller);
    try {
      await this.store.update(id, state => {
        if (state.role !== "voice") throw new Error("Voice scribe is only available in the Voice Agent");
        state.status = "running";
        state.lastRunAt = new Date().toISOString();
        delete state.error;
      });
      this.emit(id, "state");
      const scribePrompt = await readFile(fileURLToPath(new URL("voice/SCRIBE.md", new URL("../../prompts/factory-agents/", import.meta.url))), "utf8");
      const changed = () => this.emit(id, "files");
      const current = await this.store.get(id);
      await this.run(id, scribePrompt, current.scribeContext ?? [], JSON.stringify({ turn: evidence }, null, 2), fileTools(this.store, id, { changed }), controller, "scribe");
      await this.store.update(id, state => { state.status = "completed"; });
    } catch (error) {
      await this.store.update(id, state => {
        if (controller.signal.aborted) {
          state.status = "interrupted";
          delete state.error;
        } else {
          state.status = "failed";
          state.error = safeError(error);
        }
      });
      if (!controller.signal.aborted) throw error;
    } finally {
      this.active.delete(id);
      this.emit(id, "state");
    }
  }
  async close(): Promise<void> {
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled(this.runs.values());
  }
  private async main(id: string, message: string, controller: AbortController): Promise<void> {
    let system = "";
    try {
      const s = await this.store.get(id);
      const definition = await this.store.definition(s.role);
      system = await this.prompt(s.role, definition);
      if (s.role === "generation") system += `\n宿主提供的目标 Runtime 工具：内建 hatch.web_search；有 Knowledge 时启用 hatch.file_search。额外声明：${this.env.HATCH_FACTORY_TARGET_TOOLS_JSON ?? "[]"}。外部连接的实际可用性由现有 Registry/Runtime 验证。当前 Product 已由宿主固定；corpus_upload 会发布到它，不要查找、选择或创建 Product。`;
      if (s.role === "evaluator") system += `\n当前 Product 已由宿主固定；hatch_tool 只会运行它，不要查找或选择 Product。启动时如需 brief_answers，从案例中选择客户可见的信息作答；不能泄露评分标准。当前 Brief 字段：${JSON.stringify(this.store.scope?.briefSpec ?? null)}。`;
      const changed = () => this.emit(id, "files");
      const todosChanged = () => this.emit(id, "todos");
      const tools = await factoryAgentTools({
        store: this.store,
        id,
        definition,
        signal: controller.signal,
        changed,
        todosChanged,
        env: this.env,
        extraTools: await this.options.extraTools?.(s, controller.signal, changed),
      });
      const messageCount = s.messages.length;
      const visibleMessages = await this.run(id, system, s.context, message, tools, controller);
      if (s.role === "voice" && !controller.signal.aborted && !hasTrailingAskUser(visibleMessages)) {
        const latest = await this.store.get(id);
        const scribePrompt = await readFile(fileURLToPath(new URL("voice/SCRIBE.md", new URL("../../prompts/factory-agents/", import.meta.url))), "utf8");
        const evidence = latest.messages.slice(messageCount);
        await this.run(id, scribePrompt, latest.scribeContext ?? [], JSON.stringify({ turn: evidence }, null, 2), fileTools(this.store, id, { changed }), controller, "scribe");
      }
      await this.store.update(id, state => { state.status = controller.signal.aborted ? "interrupted" : "completed"; delete state.activeTool; });
      this.emit(id, controller.signal.aborted ? "voice.run_interrupted" : "voice.run_completed", { runId: this.runIds.get(id) });
    } catch (error) {
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
      this.emit(id, "state");
    }
  }
  private async run(id: string, systemPrompt: string, history: AgentMessage[], userText: string, tools: AgentTool[], controller: AbortController, channel: "visible" | "scribe" = "visible"): Promise<AgentMessage[]> {
    const factory = this.options.agentFactory ?? createFactoryPiAgent;
    let turnCount = 0;
    let persistence = Promise.resolve();
    let persistenceError: unknown;
    let summarizedCount = 0;
    let summaryMessage: AgentMessage | undefined;
    const agent = factory({ env: this.env, maxTokens: 32768, initialState: { systemPrompt, messages: history, tools }, agentOptions: {
      toolExecution: "sequential",
      // askuser is a turn boundary. The tool result is persisted as a normal
      // tool result, then the next user message starts a fresh Agent turn.
      afterToolCall: async ({ toolCall }) => toolCall.name === "askuser" ? { terminate: true } : undefined,
      transformContext: async (messages, signal) => {
        const effective = summaryMessage ? [summaryMessage, ...messages.slice(summarizedCount)] : messages;
        const tokens = effective.reduce((sum, entry) => sum + estimateTokens(entry), 0);
        if (tokens < 165000) return effective;
        this.emit(id, "compacting");
        // Retain recent messages, cutting before an assistant/tool-call group.
        let cut = Math.max(summarizedCount, messages.length - 12);
        while (cut > summarizedCount && messages[cut]?.role === "toolResult") cut--;
        if (cut <= summarizedCount) throw new Error("当前上下文过大；请缩小单份工具输出或输入后继续");
        const prefix = [...(summaryMessage ? [summaryMessage] : []), ...messages.slice(summarizedCount, cut)];
        const { models, model } = createFactoryPiModels({ env: this.env, maxTokens: 8000 });
        const summary = await generateSummaryWithUsage(prefix, models, model, 10000, signal, "Preserve current user requirements, decisions, unresolved work, exact file paths and real upload/run receipts. Source files remain readable; never invent successful operations.");
        if (!summary.ok) throw summary.error;
        summaryMessage = createCompactionSummaryMessage(summary.value.text, tokens, new Date().toISOString());
        summarizedCount = cut;
        const compacted = [summaryMessage, ...messages.slice(cut)];
        await persistence;
        await this.store.update(id, state => { state.context = compacted; });
        return compacted;
      }
    } });
    const abort = () => agent.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("运行达到时间预算，可检查已有文件后继续")), this.options.deadlineMs ?? 1800000);
    const unsubscribe = agent.subscribe(event => {
      if (event.type === "turn_start" && ++turnCount > (this.options.maxTurns ?? 80)) controller.abort(new Error("运行达到工具轮次预算，可检查已有文件后继续"));
      if (event.type === "message_end") {
        persistence = persistence.then(async () => {
          await this.store.update(id, s => {
            if (channel === "visible") { s.messages.push(event.message); s.context.push(event.message); }
            else { s.scribeContext ??= []; s.scribeContext.push(event.message); }
          });
          if (channel === "visible") this.emit(id, "message");
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
      await agent.prompt(userText);
      await persistence;
      if (persistenceError) throw persistenceError;
      controller.signal.throwIfAborted();
      const last = agent.state.messages.at(-1);
      if (last?.role === "assistant" && ["error", "aborted", "length"].includes(last.stopReason)) throw new Error(last.errorMessage || `Model stopped: ${last.stopReason}`);
      return agent.state.messages;
    } finally { clearTimeout(timer); unsubscribe(); controller.signal.removeEventListener("abort", abort); await persistence; }
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
