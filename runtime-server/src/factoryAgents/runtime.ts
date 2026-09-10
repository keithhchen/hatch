import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { Type } from "@earendil-works/pi-ai";
import { result } from "./files.js";
import { createCompactionSummaryMessage, estimateContextTokens, estimateTokens, generateSummaryWithUsage, type Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createFactoryPiAgent, createFactoryPiModels, type FactoryPiAgentOptions } from "../creatorLearning/factoryPi.js";
import { classifyFactoryProviderFailure } from "../creatorLearning/factoryLlm.js";
import { WorkbenchStore, type Role, type Session } from "./store.js";
import { fileTools } from "./tools.js";
import { webTools } from "./web.js";

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
  async prompt(role: Role): Promise<string> {
    const root = new URL("../../prompts/factory-agents/", import.meta.url);
    const own = await readFile(fileURLToPath(new URL(`${role}/SYSTEM.md`, root)), "utf8");
    const upstream: Partial<Record<Role, Role[]>> = { voice: ["research"], generation: ["research", "voice", "evaluator"], "case-generation": ["research", "voice", "generation"], evaluator: ["generation", "case-generation"] };
    const folders = ["input/manual", ...(upstream[role] ?? []).map(source => `input/${source}`)];
    return `${own}\n\n# 本 Agent 的 Input\n\n你有且只有这些输入文件夹：${folders.map(folder => `\`${folder}/\``).join("、")}。\n\`input/manual/\` 是用户手动提供的文件；其余目录是上游 Agent 的实时只读 output projection。使用 list 查看，使用 read 读取。不要要求用户复制或转发上游文件，也不要尝试修改上游目录。\n\n${await readFile(fileURLToPath(new URL("COMMON.md", root)), "utf8")}`;
  }
  async start(id: string, message: string): Promise<void> {
    if (!message.trim() || message.length > 100000) throw new Error("Provide a message of 1–100000 characters");
    if (this.active.has(id)) throw new Error("This conversation is already running");
    const controller = new AbortController();
    const runId = `factory_${Date.now()}_${id}`;
    this.active.set(id, controller);
    this.runIds.set(id, runId);
    try {
      await this.store.update(id, s => { if (s.title === s.role) s.title = message.trim().slice(0, 60); s.turn++; s.status = "running"; delete s.error; delete s.activeTool; });
    } catch (error) { this.active.delete(id); throw error; }
    this.emit(id, "state");
    this.emit(id, "voice.run_started", { runId });
    const run = this.main(id, message, controller).catch(error => this.emit(id, "error", { message: safeError(error) }));
    this.runs.set(id, run);
    void run.finally(() => { if (this.runs.get(id) === run) this.runs.delete(id); });
  }
  stop(id: string): void { this.active.get(id)?.abort(new Error("用户停止了运行")); }
  async close(): Promise<void> {
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled(this.runs.values());
  }
  private async main(id: string, message: string, controller: AbortController): Promise<void> {
    let system = "";
    try {
      const s = await this.store.get(id);
      system = await this.prompt(s.role);
      if (s.role === "generation") system += `\n宿主提供的目标 Runtime 工具：内建 hatch.web_search；有 Knowledge 时启用 hatch.file_search。额外声明：${this.env.HATCH_FACTORY_TARGET_TOOLS_JSON ?? "[]"}。外部连接的实际可用性由现有 Registry/Runtime 验证。\n当前 Product 绑定：${JSON.stringify(s.generation ?? null)}。`;
      if (s.role === "evaluator") system += `\n用户选择的真实 Hatch 目标及 Brief 字段：${JSON.stringify(s.target ?? null)}。启动时如需 brief_answers，从案例中选择客户可见的信息作答；不能泄露评分标准。`;
      const changed = () => this.emit(id, "files");
      const tools = [ this.todoTool(id), ...fileTools(this.store, id, { changed }), ...(["research", "voice"].includes(s.role) ? webTools(this.store, id, changed, this.env) : []), ...(await this.options.extraTools?.(s, controller.signal, changed) ?? []) ];
      const messageCount = s.messages.length;
      await this.run(id, system, s.context, message, tools, controller);
      if (s.role === "voice" && !controller.signal.aborted) {
        const latest = await this.store.get(id);
        const scribePrompt = await readFile(fileURLToPath(new URL("voice/SCRIBE.md", new URL("../../prompts/factory-agents/", import.meta.url))), "utf8");
        const evidence = latest.messages.slice(messageCount);
        await this.run(id, scribePrompt, latest.scribeContext ?? [], JSON.stringify({ turn: evidence }, null, 2), fileTools(this.store, id, { changed }), controller, "scribe");
      }
      await this.store.update(id, state => { state.status = controller.signal.aborted ? "interrupted" : "completed"; delete state.activeTool; });
      this.emit(id, controller.signal.aborted ? "voice.run_interrupted" : "voice.run_completed", { runId: this.runIds.get(id) });
    } catch (error) {
      await this.store.update(id, s => { s.status = controller.signal.aborted ? "interrupted" : "failed"; s.error = safeError(error); delete s.activeTool; });
      this.emit(id, controller.signal.aborted ? "voice.run_interrupted" : "voice.run_failed", { runId: this.runIds.get(id) });
    } finally {
      this.active.delete(id);
      this.runIds.delete(id);
      this.emit(id, "state");
    }
  }
  private todoTool(id: string): AgentTool {
    const item = Type.Object({ title: Type.String({ minLength: 1, maxLength: 160 }), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]) });
    return { name: "update_todo", label: "更新待办", description: "Read or replace this Agent's short current todo list. Omit todos to read it; pass the complete list to replace it; pass [] to clear it. Use only for meaningful multi-step work. Keep at most one item in_progress and update it when work actually moves.", parameters: Type.Object({ todos: Type.Optional(Type.Array(item, { maxItems: 12 })) }), execute: async (_id, raw) => { const { todos } = raw as { todos?: Array<{ title: string; status: "pending" | "in_progress" | "completed" }> }; if (todos === undefined) return result({ todos: (await this.store.get(id)).todos }); if (todos.filter(todo => todo.status === "in_progress").length > 1) throw new Error("Only one todo may be in_progress"); if (todos.some(todo => !todo.title.trim())) throw new Error("Todo titles must not be empty"); await this.store.update(id, session => { session.todos = todos.map(todo => ({ ...todo, title: todo.title.trim() })); }); this.emit(id, "todos"); return result({ todos: (await this.store.get(id)).todos, saved: true }); } };
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

export function safeError(error: unknown): string {
  const provider = classifyFactoryProviderFailure(error);
  if (provider) return provider.message;
  return (error instanceof Error ? error.message : String(error)).replace(/\b(?:sk-|tvly-|fc-)[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 1000);
}
