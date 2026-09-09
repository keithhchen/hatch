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
  private readonly env: NodeJS.ProcessEnv;
  constructor(readonly store: WorkbenchStore, private options: WorkbenchRuntimeOptions = {}) {
    this.env = { HATCH_FACTORY_LLM_PROFILE: "deepseek-v4-flash", ...(options.env ?? process.env) };
  }
  emit(id: string, type: string, data: Record<string, unknown> = {}): void { this.events.emit("event", { sessionId: id, type, ...data }); }
  async prompt(role: Role): Promise<string> {
    const root = new URL("../../prompts/factory-agents/", import.meta.url);
    const own = await readFile(fileURLToPath(new URL(`${role}/SYSTEM.md`, root)), "utf8");
    return `${own}\n\n${await readFile(fileURLToPath(new URL("COMMON.md", root)), "utf8")}`;
  }
  async start(id: string, message: string): Promise<void> {
    if (!message.trim() || message.length > 100000) throw new Error("Provide a message of 1–100000 characters");
    if (this.active.has(id)) throw new Error("This conversation is already running");
    const controller = new AbortController();
    this.active.set(id, controller);
    try {
      await this.store.update(id, s => { if (s.title === s.role) s.title = message.trim().slice(0, 60); s.turn++; s.status = "running"; delete s.error; delete s.activeTool; s.progress.status = "unscored"; });
    } catch (error) { this.active.delete(id); throw error; }
    this.emit(id, "state");
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
      const tools = [ this.progressTool(id, s.turn), ...fileTools(this.store, id, { changed }), ...(s.role === "research" ? webTools(this.store, id, changed, this.env) : []), ...(await this.options.extraTools?.(s, controller.signal, changed) ?? []) ];
      await this.run(id, system, s.context, message, tools, controller);
      await this.store.update(id, state => { state.status = controller.signal.aborted ? "interrupted" : "completed"; delete state.activeTool; });
    } catch (error) {
      await this.store.update(id, s => { s.status = controller.signal.aborted ? "interrupted" : "failed"; s.error = safeError(error); delete s.activeTool; });
    } finally {
      this.active.delete(id);
      this.emit(id, "state");
    }
  }
  private progressTool(id: string, turn: number): AgentTool {
    return { name: "report_progress", label: "报告完成度", description: "Before every final chat response, report task completion as a single integer 0–100 based on actual work. Call after file writes and other actions. 100 means requirements completed, not perfect quality or expert approval. This tool only records progress; its receipt is not user confirmation or permission to begin another task.", parameters: Type.Object({ percentage: Type.Integer({ minimum: 0, maximum: 100 }) }), execute: async (_id, raw) => {
      const { percentage } = raw as { percentage: number };
      if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) throw new Error("percentage must be an integer from 0 to 100");
      await this.store.update(id, s => { if (s.turn !== turn) throw new Error("Stale turn"); s.progress = { percentage, status: "ready", turn, revision: s.revision }; });
      this.emit(id, "progress");
      return result({ percentage, recorded: true });
    } };
  }
  private async run(id: string, systemPrompt: string, history: AgentMessage[], userText: string, tools: AgentTool[], controller: AbortController): Promise<AgentMessage[]> {
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
            s.messages.push(event.message); s.context.push(event.message);
          });
          this.emit(id, "message");
        }).catch(error => { persistenceError = error; controller.abort(); });
      }
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") this.emit(id, "delta", { text: update.delta });
        if (update.type === "thinking_start") this.emit(id, "thinking");
      }
      if (event.type === "tool_execution_start") {
        persistence = persistence.then(() => this.store.update(id, s => { s.activeTool = event.toolName; }));
        this.emit(id, "tool", { name: event.toolName });
      }
      if (event.type === "tool_execution_end") this.emit(id, "tool_end", { name: event.toolName, isError: event.isError });
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
