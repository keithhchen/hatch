import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { WorkbenchStore, type AgentDefinitionSource, type AssistantDeskState, type AssistantRole, type IngressItem, type MessageOrigin, type Role, type Session, type Todo, type WorkbenchBackend } from "../factoryAgents/store.js";
import { WorkbenchRuntime, safeError, type WorkbenchRuntimeOptions } from "../factoryAgents/runtime.js";
import type { FactoryWorkspace } from "../factoryAgents/service.js";
import type { AgentCatalog, AgentChange } from "./catalog.js";
import { convertUpload } from "../factoryAgents/markdownConverter.js";
import { imageMime, userMessage } from "../factoryAgents/imageRefs.js";
import type { Journal, JournalEvent } from "../factoryAgents/journal.js";
import type { Workshop } from "../conversations/assets.js";
import { CHANNEL_KINDS, CHANNEL_LABELS, type ChannelKind, type OutboundMessage } from "../channels/types.js";
import type { AssistantChannels } from "../channels/ports.js";
import { localDate, localHour, type AccountReach } from "./reach.js";
import type { AssistantTask, TaskKind, TaskOrigin, TaskRepository } from "./tasks.js";

const WORKER_LEASE_MS = 35 * 60_000;
const ASSISTANT_PROFILE = "kimi-k2.6";
const RUN_END = new Set(["voice.run_completed", "voice.run_failed", "voice.run_interrupted"]);
const MATERIALS = "input/materials/";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSION: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
const REVIEW_LABELS: Partial<Record<TaskKind, [string, string]>> = {
  content: ["定稿", "不要"], change: ["确认", "取消"],
};

/** The work the Assistant can start. Interview is a live conversation; the rest run in the background. */
const WORKER_KINDS = ["interview", "content", "research", "agent_research", "build", "evaluate"] as const;
export type WorkerKind = typeof WORKER_KINDS[number];
type WorkerStart = { accountId: string; kind: WorkerKind; productId?: string; agentName?: string; instruction: string; origin: TaskOrigin };
type WorkerFinish = (task: AssistantTask, session: Session, store: WorkbenchStore) => Promise<void>;
type WorkerSpec = {
  /** One line for the Assistant's start_task tool. */
  about: string;
  needsAgent: boolean;
  start: (input: WorkerStart) => Promise<AssistantTask>;
  finish: WorkerFinish;
  /** Product roles run in order. */
  steps?: readonly Role[];
  /** A handoff, not a background job: the worker takes over the conversation, so starting it ends the Assistant's turn. */
  handsOver?: boolean;
};

export type ProductWorkspaces = {
  workspace(scope: { creatorId: string; productId: string }, token: string): Promise<FactoryWorkspace>;
  attachAssistant(hooks: { grantedTools: (scope: { creatorId: string; productId: string }, session: Session) => AgentTool[]; withheldTools: (scope: { creatorId: string; productId: string }, session: Session) => Promise<string[]>; opened: (scope: { creatorId: string; productId: string }, workspace: FactoryWorkspace) => void }): void;
};

export type AssistantDependencies = {
  tasks: TaskRepository;
  reach: AccountReach;
  /** Where its messages go: the channel layer, which knows every platform so the Assistant knows none. */
  channels: AssistantChannels;
  products: ProductWorkspaces;
  catalog: AgentCatalog;
  /** The Assistant workspace of one account: its sessions and files. */
  backend: (accountId: string) => WorkbenchBackend;
  /** Runs fn only if this process holds the named cluster-wide lock. */
  exclusive: (name: string, fn: () => Promise<void>) => Promise<void>;
  env: NodeJS.ProcessEnv;
  runtime?: Pick<WorkbenchRuntimeOptions, "agentFactory" | "deadlineMs" | "maxTurns">;
  /** Where the Expert's conversation is recorded: the journal of a runtime, told which of its events belong to the conversation. */
  journal?: (keyOf: (event: JournalEvent) => string | undefined) => Journal;
};

/**
 * Where a desk's turn is. The decision to steer or start is made in one synchronous step against this phase, so
 * a message cannot be steered into a turn that is ending, and two turns cannot start at once.
 * idle: nothing runs. running: a turn takes steers. compacting: the turn is summarizing, messages wait.
 * ending: the turn has finished and is being settled; messages wait for the next turn.
 */
type Phase = "idle" | "running" | "compacting" | "ending";

type Desk = {
  accountId: string;
  store: WorkbenchStore;
  runtime: WorkbenchRuntime;
  sessionId: string;
  phase: Phase;
  /** Ingress items handed to the running turn, by id. */
  taken: Map<string, IngressItem>;
  turnStart: number;
  createdTasks: Set<string>;
  /** The latest pump; the next one waits for it. */
  pumps: Promise<unknown>;
};

/**
 * One Assistant per account. It talks with the Expert, routes work to workbench
 * sessions and turns their results back into short replies. It never does the
 * work itself.
 */
export class AssistantService {
  readonly events = new EventEmitter();
  private desks = new Map<string, Promise<Desk>>();
  private observed = new WeakSet<FactoryWorkspace>();
  private definitions: AgentDefinitionSource;
  private closing = false;
  /** Adding a worker means adding one entry here: the tool, dispatch and completion all read from it. */
  private workers: Record<WorkerKind, WorkerSpec> = {
    interview: {
      about: "interview 访谈（需要 agent_id）",
      needsAgent: true,
      handsOver: true,
      start: input => this.startInterview(input),
      finish: async () => undefined,
    },
    content: {
      about: "content 把访谈里专家的原话写成一篇内容（需要 agent_id）",
      needsAgent: true,
      start: this.workspaceWorker({ role: "content", summary: name => `为「${name}」写内容`, prepare: async (input, desk, workerId) => { await this.copyInterview(input.accountId, input.productId!, desk.store, workerId); await this.copyMaterials(desk, workerId); } }),
      finish: this.review("output/CONTENT.md", "内容写好了，等专家定稿："),
    },
    research: {
      about: "research 查专家是谁并读他的公开资料（不需要 agent_id，instruction 写专家的身份或线索：名字、职业、机构、链接）",
      needsAgent: false,
      start: this.workspaceWorker({ role: "profile-research", summary: () => "读公开资料", message: instruction => `关于专家：${instruction}`, prepare: (_input, desk, workerId) => this.copyMaterials(desk, workerId) }),
      finish: (task, session, store) => this.finishResearch(task, session, store),
    },
    agent_research: {
      about: "agent_research 为某个 Agent 做深度人物调研，写进它的构建资料（需要 agent_id）",
      needsAgent: true,
      steps: ["research"],
      start: this.pipeline("调研"),
      finish: this.announce("调研写好了：", "output/RESEARCH.md"),
    },
    build: {
      about: "build 按最新的访谈和专家要的改动构建 Agent，只构建不发布（需要 agent_id）",
      needsAgent: true,
      steps: ["generation"],
      start: this.pipeline("构建"),
      finish: this.announce("构建好了，还没发布："),
    },
    evaluate: {
      about: "evaluate 用新案例评测线上 Agent，不改动它（需要 agent_id）",
      needsAgent: true,
      steps: ["case-generation", "evaluator"],
      start: this.pipeline("评测"),
      finish: this.announce("评测跑完了：", "output/EVALUATION.md"),
    },
  };

  constructor(private deps: AssistantDependencies) {
    this.events.setMaxListeners(0);
    this.definitions = assistantDefinitions();
    deps.products.attachAssistant({
      grantedTools: (scope, session) => session.role === "voice" && session.assistantTaskId ? [this.handoffTool(session.assistantTaskId)] : [],
      // Publishing is the Assistant's tool, after the Expert confirms. A build it started has no way to go live.
      withheldTools: async (_scope, session) => session.role === "generation" && (await this.deps.tasks.bySession(session.id))?.kind === "build" ? ["corpus_upload"] : [],
      opened: (scope, workspace) => this.observe(scope.creatorId, workspace),
    });
  }

  // ── Ingress ────────────────────────────────────────────────────────────

  /** Stop the Assistant's running turn. */
  async stop(accountId: string): Promise<void> { const desk = await this.desk(accountId); desk.runtime.stop(desk.sessionId); }

  /** Durably accept one inbound item. Returns false for an item already accepted: a caller that names the item (a channel message does, by its inbox id) can repeat itself safely. */
  async ingest(accountId: string, item: Incoming): Promise<boolean> {
    const accepted = await this.accept(accountId, item);
    if (accepted) void this.pump(accountId).catch(error => this.report(accountId, error));
    return accepted;
  }

  /** Like `ingest`, but returns once the item has met its turn, with the Run that took it. An item that waits for the next turn has none. */
  async submit(accountId: string, item: Incoming): Promise<{ runId?: string }> {
    if (await this.accept(accountId, item)) await this.pump(accountId).catch(error => this.report(accountId, error));
    const desk = await this.desk(accountId);
    const interview = deskState(await desk.store.get(desk.sessionId)).interview;
    return { runId: interview ? (await this.workspace(accountId, interview.productId)).runtime.runId(interview.sessionId) : desk.runtime.runId(desk.sessionId) };
  }

  private async accept(accountId: string, item: Incoming): Promise<boolean> {
    const desk = await this.desk(accountId);
    const accepted = await desk.store.update(desk.sessionId, session => {
      const state = deskState(session);
      if (item.id !== undefined && (state.ingress.some(entry => entry.id === item.id) || session.messages.some(message => originOf(message)?.itemId === item.id))) return false;
      const at = new Date().toISOString();
      if (fromExpert(item)) state.lastExpert = { source: item.source as ExpertSource, at, ...(item.messageRef ? { messageRef: item.messageRef } : {}) };
      state.ingress.push({ id: randomUUID(), at, ...item });
      return true;
    });
    return accepted;
  }

  /** Hand pending ingress to the interview, the running turn, or a new turn. One at a time per desk: a pump that comes second finds the first one's turn already started. */
  private async pump(accountId: string): Promise<void> {
    const desk = await this.desk(accountId);
    const run = desk.pumps.then(() => this.pumpOnce(accountId, desk));
    desk.pumps = run.catch(() => undefined);
    return run;
  }

  private async pumpOnce(accountId: string, desk: Desk): Promise<void> {
    if (this.closing) return;
    const state = deskState(await desk.store.get(desk.sessionId));
    const pending = state.ingress.filter(item => !desk.taken.has(item.id));
    if (!pending.length) return;
    // The interview holds the conversation. Task news stays in ingress until it hands back.
    if (state.interview) {
      const expert = pending.filter(fromExpert);
      if (expert.length) await this.passToInterview(desk, state.interview, expert);
      return;
    }
    // From here to the decision there is no await, so the phase cannot change under it.
    if (desk.phase === "idle") {
      desk.phase = "running";
      await this.startTurn(desk).catch(error => { desk.taken = new Map(); desk.phase = "idle"; this.report(accountId, error); });
      return;
    }
    // A turn that is summarizing or ending takes nothing: turnEnded and the end of compaction pump again.
    if (desk.phase !== "running") return;
    let waiting = false;
    for (const item of pending) {
      if (desk.runtime.steer(desk.sessionId, itemMessage(item))) desk.taken.set(item.id, item);
      else waiting = true;
    }
    // The turn has not reached its model loop yet; try again shortly.
    if (waiting) setTimeout(() => void this.pump(accountId).catch(error => this.report(accountId, error)), 50);
  }

  private async startTurn(desk: Desk): Promise<void> {
    const session = await desk.store.get(desk.sessionId);
    const state = deskState(session);
    const pending = state.ingress.filter(item => !desk.taken.has(item.id));
    if (state.interview || !pending.length) { desk.phase = "idle"; return; }
    desk.taken = new Map(pending.map(item => [item.id, item]));
    desk.turnStart = session.messages.length;
    desk.createdTasks.clear();
    await desk.store.update(desk.sessionId, s => {
      for (const item of deskState(s).ingress) if (desk.taken.has(item.id)) item.attempts = (item.attempts ?? 0) + 1;
    });
    await desk.runtime.start(desk.sessionId, pending.map(itemMessage));
  }

  private async turnEnded(desk: Desk, type: string): Promise<void> {
    if (this.closing) return;
    try { await this.settleTurn(desk, type); } finally { desk.phase = "idle"; }
    void this.pump(desk.accountId).catch(error => this.report(desk.accountId, error));
  }

  private async settleTurn(desk: Desk, type: string): Promise<void> {
    const session = await desk.store.get(desk.sessionId);
    const turn = session.messages.slice(desk.turnStart);
    const said = new Set(turn.flatMap(message => { const origin = originOf(message); return origin ? [origin.itemId] : []; }));
    const taken = [...desk.taken.values()];
    desk.taken = new Map();
    // An item leaves ingress once it is in the context. Items that never got
    // there stay for the next turn, unless they already failed three turns.
    const dropped: IngressItem[] = [];
    await desk.store.update(desk.sessionId, s => {
      const state = deskState(s);
      state.ingress = state.ingress.filter(item => {
        if (said.has(item.id)) return false;
        if ((item.attempts ?? 0) >= 3) { dropped.push(item); return false; }
        return true;
      });
    });
    const reply = finalText(turn);
    if (type === "voice.run_completed" && reply) await this.deliver(desk, reply, taken);
    if (type === "voice.run_failed") await this.deliver(desk, `我这边出了点问题，刚才那条没处理完：${session.error ?? "未知错误"}`, taken);
    if (dropped.length) this.report(desk.accountId, new Error(`Dropped ${dropped.length} ingress item(s) after three failed turns`));
    this.emit(desk.accountId, { type: "assistant" });
  }

  // ── Delivery ───────────────────────────────────────────────────────────

  /**
   * Studio reads the session directly. A reply goes back to the thread it came
   * from; a proactive message goes where the Expert was last, unless they are in Studio now.
   */
  private async deliver(desk: Desk, text: string, origins: IngressItem[]): Promise<void> {
    const state = deskState(await desk.store.get(desk.sessionId));
    const replying = [...origins].reverse().find(item => isChannel(item.source));
    const expertInvolved = origins.some(fromExpert);
    const activeInStudio = state.lastExpert?.source === "web" && Date.now() - Date.parse(state.lastExpert.at) < 10 * 60_000;
    if (!replying && (expertInvolved || activeInStudio)) return;
    const last = state.lastExpert && isChannel(state.lastExpert.source) ? state.lastExpert.source : undefined;
    const buttons = await this.reviewButtons(desk, origins);
    const message = { text, ...(buttons.length ? { buttons } : {}) };
    const { channels } = this.deps;
    // The final reply goes where the message came from; anything else goes where the Expert was last.
    try {
      if (replying?.eventId && await channels.reply(replying.eventId, message)) return;
      await channels.push(desk.accountId, message, (replying?.source as ChannelKind | undefined) ?? last);
    } catch (error) { this.report(desk.accountId, error); }
  }

  private async reviewButtons(desk: Desk, origins: IngressItem[]): Promise<NonNullable<OutboundMessage["buttons"]>> {
    const ids = new Set([...origins.flatMap(item => item.taskId ? [item.taskId] : []), ...desk.createdTasks]);
    const buttons: NonNullable<OutboundMessage["buttons"]> = [];
    for (const id of ids) {
      const task = await this.deps.tasks.get(id);
      const labels = task && REVIEW_LABELS[task.kind];
      if (!task || task.status !== "needs_you" || task.needs !== "review" || !labels) continue;
      buttons.push({ label: labels[0], taskId: id, action: "approve" }, { label: labels[1], taskId: id, action: "decline" });
    }
    return buttons.slice(0, 4);
  }

  // ── Interview pass-through ─────────────────────────────────────────────

  private async passToInterview(desk: Desk, interview: NonNullable<AssistantDeskState["interview"]>, items: IngressItem[]): Promise<void> {
    const workspace = await this.workspace(desk.accountId, interview.productId);
    // A file the Expert sends mid-interview must be readable by the interview, at the path it can see.
    const raw = items.map(spoken).join("\n\n");
    if (raw.includes(MATERIALS)) await this.shareMaterials(desk.accountId, interview.productId);
    const text = raw.replaceAll(MATERIALS, "input/manual/");
    for (const item of items) desk.taken.set(item.id, item);
    // The Expert's words also join the Assistant's history, so it knows what was said.
    await desk.runtime.commit(desk.sessionId, () => desk.store.update(desk.sessionId, s => {
      for (const item of items) { const message: AgentMessage = { ...itemMessage(item), timestamp: Date.parse(item.at) }; s.messages.push(message); s.context.push(message); }
      const state = deskState(s);
      state.ingress = state.ingress.filter(entry => !items.some(item => item.id === entry.id));
    }));
    for (const item of items) desk.taken.delete(item.id);
    const images = items.flatMap(item => item.images ?? []);
    for (const image of images) await workspace.store.put(interview.sessionId, image, (await desk.store.read(desk.sessionId, image)).bytes, { actor: "host", mimeType: imageMime(image) });
    if (workspace.runtime.isRunning(interview.sessionId) && workspace.runtime.steer(interview.sessionId, text, images)) return;
    await workspace.runtime.start(interview.sessionId, text, images);
    this.emit(desk.accountId, { type: "assistant" });
  }

  private async interviewTurnEnded(task: AssistantTask, workspace: FactoryWorkspace, type: string): Promise<void> {
    const desk = await this.desk(task.accountId);
    const voice = await workspace.store.get(task.session!.sessionId);
    const state = deskState(await desk.store.get(desk.sessionId));
    const relayFrom = state.interview?.taskId === task.id ? state.interview.relayFrom : voice.messages.length;
    const reply = finalText(voice.messages.slice(relayFrom));
    if (reply) {
      await desk.runtime.commit(desk.sessionId, () => desk.store.update(desk.sessionId, s => {
        const message = relayedMessage(reply);
        s.messages.push(message); s.context.push(message);
        const current = deskState(s);
        if (current.interview?.taskId === task.id) current.interview.relayFrom = voice.messages.length;
      }));
      const lastExpert = state.lastExpert;
      await this.deliver(desk, reply, lastExpert && isChannel(lastExpert.source) ? [{ id: "relay", at: lastExpert.at, source: lastExpert.source, text: "", ...(lastExpert.messageRef ? { messageRef: lastExpert.messageRef } : {}) }] : [{ id: "relay", at: new Date().toISOString(), source: "task", text: "" }]);
    }
    const latest = (await this.deps.tasks.get(task.id))!;
    const handoff = typeof latest.payload.handoff === "string" ? latest.payload.handoff : undefined;
    if (type === "voice.run_completed" && !handoff) { this.emit(task.accountId, { type: "assistant" }); return; }
    await this.endInterview(desk, workspace, latest);
    if (type === "voice.run_completed") {
      await this.deps.tasks.update(task.id, { status: "done", summary: handoff });
      await this.ingest(task.accountId, { source: "task", taskId: task.id, text: `访谈结束，交回给你。访谈那边的小结：${handoff}${outlineText(voice.todos)}` });
    } else {
      await this.block(task, voice.error ?? "访谈中断了");
    }
  }

  private async endInterview(desk: Desk, workspace: FactoryWorkspace, task: AssistantTask): Promise<void> {
    await desk.store.update(desk.sessionId, s => { const state = deskState(s); if (state.interview?.taskId === task.id) delete state.interview; });
    await workspace.store.update(task.session!.sessionId, s => { if (s.assistantTaskId === task.id) delete s.assistantTaskId; });
    // Expert messages that waited for the interview now go to the Assistant.
    void this.pump(task.accountId).catch(error => this.report(task.accountId, error));
  }

  private handoffTool(taskId: string): AgentTool {
    return {
      name: "handoff_to_assistant",
      label: "交回助理",
      description: "把对话交回助理。派活、查资料、写东西、发布，以及系统和工具的问题，都只有助理能处理。以下情况立刻调用，不要自己回答：专家要你查、搜、写、做任何访谈之外的事；专家问你能做什么、某个功能为什么不行；专家想停；大纲聊完了。note 写：专家的原话和他要什么、聊到了哪、还剩哪几件。调用后本轮结束，不要再回复专家。",
      parameters: Type.Object({ note: Type.String({ minLength: 1, maxLength: 600 }) }),
      execute: async (_id, raw) => {
        const { note } = raw as { note: string };
        const task = await this.deps.tasks.get(taskId);
        if (task) await this.deps.tasks.update(taskId, { payload: { ...task.payload, handoff: note.trim() } });
        return { content: [{ type: "text" as const, text: "已交回助理。本轮到此结束。" }], details: {}, terminate: true };
      },
    };
  }

  // ── Tasks ──────────────────────────────────────────────────────────────

  /** Start one piece of work. What it takes and how it ends is declared in this.workers. */
  async dispatch(accountId: string, kind: WorkerKind, productId: string | undefined, instruction: string, origin: TaskOrigin): Promise<AssistantTask> {
    const worker = this.workers[kind];
    if (worker.needsAgent && !productId) throw new Error("这件事要指定 Agent");
    const agent = productId ? await this.deps.catalog.get(accountId, productId) : undefined;
    if (productId && !agent) throw Object.assign(new Error("没有找到这个 Agent"), { status: 404 });
    if (agent) await this.shareMaterials(accountId, agent.productId);
    return worker.start({ accountId, kind, productId: agent?.productId, agentName: agent?.name, instruction, origin });
  }

  private async startInterview(input: WorkerStart): Promise<AssistantTask> {
    const { accountId, kind, instruction, origin } = input; const productId = input.productId!;
    const desk = await this.desk(accountId);
    if (deskState(await desk.store.get(desk.sessionId)).interview) throw new Error("已经有一个访谈在进行，先结束它");
    const workspace = await this.workspace(accountId, productId);
    const voice = (await workspace.store.list()).find(session => session.role === "voice") ?? await workspace.store.create("voice");
    if (workspace.runtime.isRunning(voice.id)) throw new Error("这个 Agent 的访谈正在 Studio 里进行，稍后再试");
    const task = await this.deps.tasks.create({ accountId, productId, kind, origin, session: { scope: "product", sessionId: voice.id }, payload: { instruction }, summary: `补访谈「${input.agentName}」` });
    await workspace.store.update(voice.id, s => { s.assistantTaskId = task.id; });
    await desk.store.update(desk.sessionId, s => { deskState(s).interview = { taskId: task.id, productId, sessionId: voice.id, relayFrom: voice.messages.length }; });
    await workspace.runtime.start(voice.id, `[Hatch 助理请你做一次访谈]\n\n要了解的：${instruction}\n\n现在问第一个问题。`);
    return task;
  }

  /** The interview outline is the interview session's todo list: one source, read wherever it is needed. */
  private async interviewOutline(accountId: string, productId: string): Promise<Todo[]> {
    const workspace = await this.workspace(accountId, productId);
    return (await workspace.store.list()).find(session => session.role === "voice")?.todos ?? [];
  }

  /** A worker that runs in the Assistant's own workspace. */
  private workspaceWorker(spec: { role: AssistantRole; summary: (agentName: string) => string; message?: (instruction: string) => string; prepare: (input: WorkerStart, desk: Desk, workerId: string) => Promise<void> }): WorkerSpec["start"] {
    return async input => {
      const desk = await this.desk(input.accountId);
      const summary = spec.summary(input.agentName ?? "");
      const worker = await desk.store.create(spec.role, summary);
      await spec.prepare(input, desk, worker.id);
      const task = await this.deps.tasks.create({ accountId: input.accountId, productId: input.productId, kind: input.kind, origin: input.origin, session: { scope: "assistant", sessionId: worker.id }, payload: { instruction: input.instruction }, summary, leaseExpiresAt: lease() });
      await desk.runtime.start(worker.id, spec.message ? spec.message(input.instruction) : input.instruction);
      return task;
    };
  }

  /** A worker made of Product roles that run in order. */
  private pipeline(label: string): WorkerSpec["start"] {
    return async input => {
      const task = await this.deps.tasks.create({ accountId: input.accountId, productId: input.productId, kind: input.kind, origin: input.origin, payload: { instruction: input.instruction }, summary: `${label}「${input.agentName}」`, leaseExpiresAt: lease() });
      return this.runStep(task, this.workers[input.kind].steps![0]!);
    };
  }

  /** The Expert said a source does not count: remember it for every later piece of work. */
  async excludeSource(accountId: string, source: string, reason?: string): Promise<void> {
    const desk = await this.desk(accountId);
    const file = `${MATERIALS}不算数的来源.md`;
    const existing = await outputText(desk.store, desk.sessionId, file);
    await desk.store.put(desk.sessionId, file, Buffer.from(`${existing || "# 专家说这些来源不算数，不要采用\n"}\n- ${source}${reason ? `：${reason}` : ""}`), { actor: "host" });
  }

  /** Copy the Expert's materials into a Product's shared input, where its Agents read them. */
  private async shareMaterials(accountId: string, productId: string): Promise<void> {
    const desk = await this.desk(accountId);
    const session = await desk.store.get(desk.sessionId);
    const files = session.files.filter(file => file.path.startsWith(MATERIALS));
    if (!files.length) return;
    const workspace = await this.workspace(accountId, productId);
    for (const file of files) {
      const { bytes } = await desk.store.read(desk.sessionId, file.path);
      await workspace.store.backend.writeManual(`input/manual/${file.path.slice(MATERIALS.length)}`, bytes);
    }
  }

  private async copyMaterials(desk: Desk, workerId: string): Promise<void> {
    const session = await desk.store.get(desk.sessionId);
    for (const file of session.files.filter(candidate => candidate.path.startsWith(MATERIALS))) {
      const { bytes } = await desk.store.read(desk.sessionId, file.path);
      await desk.store.put(workerId, file.path, bytes, { actor: "host", mimeType: file.mimeType });
    }
  }

  async propose(accountId: string, productId: string, change: AgentChange, origin: TaskOrigin): Promise<AssistantTask> {
    const agent = await this.deps.catalog.get(accountId, productId);
    if (!agent) throw new Error("没有找到这个 Agent");
    const fields = Object.keys(change).filter(key => change[key as keyof AgentChange] !== undefined);
    if (!fields.length) throw new Error("没有要改的内容");
    return this.deps.tasks.create({ accountId, productId, kind: "change", origin, status: "needs_you", needs: "review", payload: { change }, summary: change.release ? `${change.release === "publish" ? "发布" : "下架"}「${agent.name}」` : `修改「${agent.name}」：${fields.join("、")}` });
  }

  async approve(accountId: string, taskId: string): Promise<AssistantTask> {
    const task = await this.ownedTask(accountId, taskId);
    if (task.status !== "needs_you" || task.needs !== "review") throw new Error("这件事现在不需要确认");
    if (task.kind === "change") await this.deps.catalog.apply(accountId, task.productId!, task.payload.change as AgentChange);
    return this.deps.tasks.update(task.id, { status: "done", summary: `${task.summary ?? ""}（已确认）` });
  }

  async decline(accountId: string, taskId: string): Promise<AssistantTask> {
    const task = await this.ownedTask(accountId, taskId);
    if (task.status !== "needs_you") throw new Error("这件事已经结束了");
    return this.deps.tasks.update(task.id, { status: "done", summary: `${task.summary ?? ""}（已取消）` });
  }

  /** Give a waiting task the Expert's answer. */
  async answer(accountId: string, taskId: string, text: string): Promise<AssistantTask> {
    const task = await this.ownedTask(accountId, taskId);
    if (task.status !== "needs_you" || task.needs !== "answer") throw new Error("这件事现在不需要回答");
    if (task.kind === "poke") return this.deps.tasks.update(task.id, { status: "done", answeredAt: new Date().toISOString() });
    const runtime = await this.sessionRuntime(task);
    await runtime.start(task.session!.sessionId, text);
    return this.deps.tasks.update(task.id, { status: "working", leaseExpiresAt: lease() });
  }

  async open(accountId: string): Promise<AssistantTask[]> { return this.deps.tasks.open(accountId); }

  private async runStep(task: AssistantTask, step: Role): Promise<AssistantTask> {
    const workspace = await this.workspace(task.accountId, task.productId!);
    const session = (await workspace.store.list()).find(candidate => candidate.role === step) ?? await workspace.store.create(step);
    if (workspace.runtime.isRunning(session.id)) throw new Error("这个 Agent 正在 Studio 里构建，稍后再试");
    const instruction = String(task.payload.instruction ?? "");
    const message = step === "generation" ? `按最新的访谈和评测构建这个 Agent。专家这次想改的：${instruction}\n这次只构建：写好并核对文件就结束，发布由助理负责。`
      : step === "case-generation" ? "根据刚更新的 Agent，构造一个新的真实客户案例。"
        : step === "evaluator" ? "用最新案例评测线上 Agent。" : instruction;
    const updated = await this.deps.tasks.update(task.id, { status: "working", session: { scope: "product", sessionId: session.id }, payload: { ...task.payload, step }, leaseExpiresAt: lease() });
    await workspace.runtime.start(session.id, message);
    return updated;
  }

  /** A worker turn ended: translate how it ended into the task and tell the Assistant. */
  private async workerTurnEnded(task: AssistantTask, store: WorkbenchStore, workspace: FactoryWorkspace | undefined, type: string): Promise<void> {
    if (this.closing) return;
    if (task.kind === "interview" && workspace) return this.interviewTurnEnded(task, workspace, type);
    const session = await store.get(task.session!.sessionId);
    if (type !== "voice.run_completed") return void await this.block(task, session.error ?? "被中断了");
    const questions = trailingQuestions(session.messages);
    if (questions.length) {
      await this.deps.tasks.update(task.id, { status: "needs_you", needs: "answer", leaseExpiresAt: undefined, payload: { ...task.payload, questions } });
      await this.ingest(task.accountId, { source: "task", taskId: task.id, text: `想问专家：\n${questions.map((question, index) => `${index + 1}. ${question}`).join("\n")}` });
      return;
    }
    const worker = this.workers[task.kind as WorkerKind];
    if (!worker) return void await this.block(task, `不认识的任务类型：${task.kind}`);
    const next = worker.steps?.[worker.steps.indexOf(task.payload.step as Role) + 1];
    if (next) return void await this.runStep(task, next);
    await worker.finish(task, session, store);
  }

  /** The result waits for the Expert's decision. */
  private review(file: string, lead: string): WorkerFinish {
    return async (task, session, store) => {
      const body = await outputText(store, session.id, file);
      if (!body) return this.block(task, `没有写出 ${file}`);
      await this.deps.tasks.update(task.id, { status: "needs_you", needs: "review", leaseExpiresAt: undefined, outputRef: `assistant:${session.id}:${file}` });
      await this.ingest(task.accountId, { source: "task", taskId: task.id, text: `${lead}\n${excerpt(body)}` });
    };
  }

  /** The work is done: tell the Assistant what came out. */
  private announce(lead: string, file?: string): WorkerFinish {
    return async (task, session, store) => {
      const body = file ? await outputText(store, session.id, file) : "";
      await this.deps.tasks.update(task.id, { status: "done", leaseExpiresAt: undefined, ...(file ? { outputRef: `product:${session.id}:${file}` } : {}) });
      await this.ingest(task.accountId, { source: "task", taskId: task.id, text: `${lead}\n${excerpt(body || finalText(session.messages))}` });
    };
  }

  private async finishResearch(task: AssistantTask, session: Session, store: WorkbenchStore): Promise<void> {
    const desk = await this.desk(task.accountId);
    const profile = await outputText(store, session.id, "output/PUBLIC_PROFILE.md");
    if (!profile.trim()) {
      await this.deps.tasks.update(task.id, { status: "done", leaseExpiresAt: undefined, summary: "没有读到公开资料" });
      await this.ingest(task.accountId, { source: "task", taskId: task.id, text: `没有读到公开资料。它的说明：${finalText(session.messages)}\n如实告诉专家是什么情况：搜索失败不等于网上没有。` });
      return;
    }
    await desk.store.put(desk.sessionId, `${MATERIALS}公开资料.md`, Buffer.from(profile), { actor: "host" });
    const interview = deskState(await desk.store.get(desk.sessionId)).interview;
    if (interview) await this.shareMaterials(task.accountId, interview.productId);
    await this.deps.tasks.update(task.id, { status: "done", leaseExpiresAt: undefined, outputRef: `assistant:${desk.sessionId}:${MATERIALS}公开资料.md` });
    await this.ingest(task.accountId, { source: "task", taskId: task.id, text: `公开资料读完了（${MATERIALS}公开资料.md）：\n${excerpt(profile)}\n\n把发现自然地接进对话，告诉专家你看过哪些来源，他可以说哪篇不算数。` });
  }

  private async block(task: AssistantTask, reason: string): Promise<void> {
    await this.deps.tasks.update(task.id, { status: "needs_you", needs: "blocked", lastError: reason, leaseExpiresAt: undefined });
    await this.ingest(task.accountId, { source: "task", taskId: task.id, text: `卡住了：${reason}` });
  }

  // ── Tick: recovery and the daily check ─────────────────────────────────

  async tick(now = new Date()): Promise<void> {
    await this.deps.exclusive("hatch-assistant-tick", async () => {
      for (const task of await this.deps.tasks.expired(now)) await this.recover(task).catch(error => this.report(task.accountId, error));
      for (const { accountId, timezone } of await this.deps.reach.assistantAccounts()) await this.dailyCheck(accountId, timezone, now).catch(error => this.report(accountId, error));
    });
  }

  private async recover(task: AssistantTask): Promise<void> {
    if (task.attempts >= 3) return this.block(task, "多次中断，没能完成");
    const runtime = await this.sessionRuntime(task);
    await this.deps.tasks.update(task.id, { attempts: task.attempts + 1, leaseExpiresAt: lease() });
    if (runtime.isRunning(task.session!.sessionId)) return;
    await runtime.start(task.session!.sessionId, "服务重启过，上一轮被中断了。先检查已有的结果，再从中断的地方继续。");
  }

  private async dailyCheck(accountId: string, timezone: string, now: Date): Promise<void> {
    const hour = localHour(timezone, now);
    if (hour < 10 || hour >= 20) return;
    // Never interrupt a live conversation: no check during an interview or right after the Expert spoke.
    const desk = await this.desk(accountId);
    const current = deskState(await desk.store.get(desk.sessionId));
    if (current.interview) return;
    if (current.lastExpert && now.getTime() - Date.parse(current.lastExpert.at) < 30 * 60_000) return;
    // A message the Expert's chats cannot take now is not worth a model call.
    if (!(await this.deps.channels.canReach(accountId))) return;
    const pokes = await this.deps.tasks.pokes(accountId, 3);
    const latest = pokes[0];
    if (latest && localDate(timezone, new Date(latest.createdAt)) === localDate(timezone, now)) return;
    const asked = pokes.filter(poke => typeof poke.payload.question === "string");
    const ignored = asked.length === 3 && asked.every(poke => !poke.answeredAt);
    if (ignored && latest && now.getTime() - Date.parse(latest.createdAt) < 3 * 24 * 3600_000) return;
    for (const poke of pokes) if (poke.status !== "done") await this.deps.tasks.update(poke.id, { status: "done" });
    const task = await this.deps.tasks.create({ accountId, kind: "poke", origin: { source: "tick" }, summary: "日常检查" });
    const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(now);
    await this.ingest(accountId, { source: "tick", taskId: task.id, text: `专家当地时间 ${clock}。看看他的 Agent 和最近的事，决定今天要不要戳一戳他。` });
  }

  // ── Studio and channel surfaces ───────────────────────────────────────

  /** What the chat shows: what the Expert said and what the Assistant said. System messages stay out. */
  async view(accountId: string): Promise<{ messages: Array<{ id: string; role: "expert" | "assistant"; text: string; at: string; images?: string[]; attachments?: NonNullable<MessageOrigin["attachments"]> }>; tasks: AssistantTask[]; running: boolean; runId?: string; interviewing: boolean }> {
    const desk = await this.desk(accountId);
    const session = await desk.store.get(desk.sessionId);
    type Line = { id: string; role: "expert" | "assistant"; text: string; at: string; images?: string[]; attachments?: NonNullable<MessageOrigin["attachments"]> };
    const messages = session.messages.flatMap((message, index): Line[] => {
      const at = new Date(message.timestamp ?? Date.now()).toISOString();
      if (message.role === "assistant") { const text = textOf(message).trim(); return text ? [{ id: `m${index + 1}`, role: "assistant", text, at }] : []; }
      const origin = originOf(message);
      if (origin?.kind !== "expert") return [];
      return [{ id: origin.itemId, role: "expert", text: origin.text ?? "", at, ...(origin.images?.length ? { images: origin.images.map(file => path.basename(file)) } : {}), ...(origin.attachments?.length ? { attachments: origin.attachments } : {}) }];
    });
    return { messages, tasks: await this.deps.tasks.open(accountId), running: desk.runtime.isRunning(desk.sessionId), runId: desk.runtime.runId(desk.sessionId), interviewing: Boolean(deskState(session).interview) };
  }

  /**
   * Keep a file as this Expert's material and tell the Assistant. Files live in
   * the Assistant session and are copied into a Product's input when work starts.
   */
  async receiveFile(accountId: string, name: string, bytes: Buffer, source: ExpertSource, ref: { id?: string; eventId?: string; messageRef?: string; caption?: string } = {}): Promise<{ name: string }> {
    const { caption, ...origin } = ref;
    const mimeType = imageMime(name);
    if (mimeType) {
      if (bytes.length > MAX_IMAGE_BYTES) throw Object.assign(new Error("这张图片太大了，超过 10 MB。可以压缩一下再发。"), { status: 413, code: "image_too_large" });
      const desk = await this.desk(accountId);
      const file = `input/images/${ref.id ?? randomUUID()}${path.extname(name).toLowerCase()}`;
      await desk.store.put(desk.sessionId, file, bytes, { actor: "host", mimeType });
      await this.ingest(accountId, { source, text: caption?.trim() ?? "", images: [file], ...origin });
      return { name };
    }
    const safe = safeName(name);
    const converted = await convertUpload(safe, bytes).catch(error => { this.report(accountId, error); throw unreadableFile(); });
    if (!converted.bytes.toString().trim()) throw unreadableFile();
    const desk = await this.desk(accountId);
    await desk.store.put(desk.sessionId, `${MATERIALS}${converted.name}`, converted.bytes, { actor: "host", mimeType: converted.mimeType });
    await this.ingest(accountId, { source, text: `（传了一份资料：${converted.name}，已存到 ${MATERIALS}${converted.name}）`, ...origin });
    return { name: converted.name };
  }

  /** Where an upload for the Assistant goes: images where the model sees them, files among the Expert's materials. */
  workshop(accountId: string): Workshop {
    return {
      files: { writeManual: async (file, bytes) => { const desk = await this.desk(accountId); await desk.store.put(desk.sessionId, file, bytes, { actor: "host", mimeType: imageMime(file) ?? "text/markdown" }); } },
      place: asset => asset.record.kind === "audio" ? "" : asset.record.kind === "image" ? `input/images/${asset.id}${IMAGE_EXTENSION[asset.derivative("resized")?.mime ?? asset.record.mime] ?? ".jpg"}` : `${MATERIALS}${asset.id.slice(0, 8)}-${safeName(asset.record.name)}.md`,
    };
  }

  async image(accountId: string, file: string): Promise<Buffer> {
    const desk = await this.desk(accountId);
    return (await desk.store.read(desk.sessionId, `input/images/${path.basename(file)}`)).bytes;
  }

  /** The Assistant's view of things right now. Rebuilt for every model call and never stored. */
  private async liveState(accountId: string): Promise<string> {
    const tasks = await this.deps.tasks.open(accountId);
    const agents = await this.deps.catalog.list(accountId);
    const lines = await Promise.all(agents.map(async agent => {
      const live = await this.deps.catalog.live(accountId, agent.productId) as { is_live?: boolean; pending_changes?: string[] } | null;
      const outline = await this.interviewOutline(accountId, agent.productId);
      return [`- 「${agent.name}」（${agent.productId}）：${live?.is_live ? "在线" : "未上线"}${live?.pending_changes?.length ? `，待发布：${live.pending_changes.join("、")}` : ""}`, ...outline.map(todo => `  ${todo.status === "completed" ? "✓" : "○"} ${todo.title}`)].join("\n");
    }));
    return `<当前状态>\n系统自动生成，不是专家说的，不要复述。\n事项：\n${tasks.map(task => `- ${task.kind}（${task.id}）${task.status}${task.needs ? `/${task.needs}` : ""}：${task.summary ?? ""}`).join("\n") || "（没有）"}\nAgent 和访谈大纲：\n${lines.join("\n") || "（没有）"}\n</当前状态>`;
  }

  /** Someone linked their chat to this Assistant. Returns what to say to them. */
  async linked(accountId: string): Promise<string> {
    const known = (await this.deps.catalog.list(accountId)).length > 0;
    this.emit(accountId, { type: "assistant" });
    return known ? "连上了。以后我会在这里找你，你也可以随时在这里跟我说话。" : "连上了。先给我一样东西就行：你的名字、一个链接，或者现成的资料。";
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const pending of this.desks.values()) {
      const desk = await pending.catch(() => undefined);
      await desk?.runtime.close();
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private desk(accountId: string): Promise<Desk> {
    if (!/^[0-9a-f-]{36}$/.test(accountId)) return Promise.reject(new Error("Invalid account ID"));
    let pending = this.desks.get(accountId);
    if (!pending) {
      pending = this.openDesk(accountId);
      this.desks.set(accountId, pending);
      pending.catch(() => this.desks.delete(accountId));
    }
    return pending;
  }

  private async openDesk(accountId: string): Promise<Desk> {
    const store = new WorkbenchStore(this.deps.backend(accountId), undefined, this.definitions);
    await store.recover();
    const sessions = await store.list();
    const session = sessions.find(candidate => candidate.role === "assistant") ?? await store.create("assistant", "Hatch 助理");
    const runtime = new WorkbenchRuntime(store, {
      ...this.deps.runtime,
      env: { ...this.deps.env, HATCH_FACTORY_LLM_PROFILE: ASSISTANT_PROFILE },
      extraTools: async target => target.role === "assistant" ? this.tools(accountId, desk) : [],
      ...(this.deps.journal ? { journal: this.deps.journal(event => event.sessionId === session.id ? `assistant:${accountId}` : undefined) } : {}),
      liveState: async id => id === desk.sessionId ? this.liveState(accountId).catch(error => { this.report(accountId, error); return "<当前状态>\n这次没有读到当前状态，需要时用 list_agents 和 list_tasks 查。\n</当前状态>"; }) : undefined,
    });
    const desk: Desk = { accountId, store, runtime, sessionId: session.id, phase: "idle", taken: new Map(), turnStart: 0, createdTasks: new Set(), pumps: Promise.resolve() };
    runtime.events.on("event", (event: { sessionId?: string; type?: string }) => {
      if (!event.sessionId || !event.type) return;
      if (event.sessionId === desk.sessionId) {
        if (["delta", "message", "state", "tool", "tool_end"].includes(event.type)) this.emit(accountId, event);
        // Synchronous, before anything else can run: from here a message waits for the next turn.
        if (RUN_END.has(event.type)) { desk.phase = "ending"; void this.turnEnded(desk, event.type).catch(error => this.report(accountId, error)); }
        else if (event.type === "compacting" && desk.phase === "running") {
          desk.phase = "compacting";
          void this.deps.channels.compacting(accountId, randomUUID()).catch(error => this.report(accountId, error));
        } else if (desk.phase === "compacting" && ["delta", "message", "tool"].includes(event.type)) {
          // Summarizing is over: what waited joins the turn.
          desk.phase = "running";
          void this.pump(accountId).catch(error => this.report(accountId, error));
        }
        return;
      }
      if (RUN_END.has(event.type)) void this.deps.tasks.bySession(event.sessionId).then(task => { if (task) return this.workerTurnEnded(task, store, undefined, event.type!); }).catch(error => this.report(accountId, error));
    });
    // Ingress left from before a restart.
    setTimeout(() => void this.pump(accountId).catch(error => this.report(accountId, error)), 0);
    return desk;
  }

  /** Product workspaces report the end of every turn; only turns the Assistant drives matter here. */
  private observe(accountId: string, workspace: FactoryWorkspace): void {
    if (this.observed.has(workspace)) return;
    this.observed.add(workspace);
    workspace.runtime.events.on("event", (event: { sessionId?: string; type?: string }) => {
      if (!event.sessionId || !event.type || !RUN_END.has(event.type)) return;
      void this.deps.tasks.bySession(event.sessionId)
        .then(task => { if (task && task.accountId === accountId) return this.workerTurnEnded(task, workspace.store, workspace, event.type!); })
        .catch(error => this.report(accountId, error));
    });
  }

  private async workspace(accountId: string, productId: string): Promise<FactoryWorkspace> {
    return this.deps.products.workspace({ creatorId: accountId, productId }, await this.deps.catalog.token(accountId));
  }

  private async sessionRuntime(task: AssistantTask): Promise<WorkbenchRuntime> {
    if (!task.session) throw new Error("这件事没有对应的执行会话");
    return task.session.scope === "product" ? (await this.workspace(task.accountId, task.productId!)).runtime : (await this.desk(task.accountId)).runtime;
  }

  private async ownedTask(accountId: string, taskId: string): Promise<AssistantTask> {
    const task = await this.deps.tasks.get(taskId);
    if (!task || task.accountId !== accountId) throw Object.assign(new Error("Task was not found"), { status: 404 });
    return task;
  }

  /** Content needs the interview: copy the persona, voice notes and transcript into the worker's input. */
  private async copyInterview(accountId: string, productId: string, store: WorkbenchStore, workerId: string): Promise<void> {
    const workspace = await this.workspace(accountId, productId);
    const voice = (await workspace.store.list()).find(session => session.role === "voice");
    if (!voice) throw new Error("这个 Agent 还没有访谈记录，先补访谈");
    for (const file of ["output/CREATOR_PERSONA.md", "output/VOICE.md"]) {
      const body = await outputText(workspace.store, voice.id, file);
      if (body.trim()) await store.put(workerId, `input/interview/${file.slice("output/".length)}`, Buffer.from(body), { actor: "host" });
    }
    const transcript = voice.messages.flatMap(message => {
      const text = message.role === "user" || message.role === "assistant" ? textOf(message).trim() : "";
      return text ? [`**${message.role === "user" ? "专家" : "访谈"}**：${text}`] : [];
    }).join("\n\n");
    if (!transcript) throw new Error("这个 Agent 的访谈还是空的，先补访谈");
    await store.put(workerId, "input/interview/TRANSCRIPT.md", Buffer.from(transcript), { actor: "host" });
  }

  private tools(accountId: string, desk: Desk): AgentTool[] {
    const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], details: {} });
    const origin = (): TaskOrigin => ({ source: ([...desk.taken.values()].find(item => isChannel(item.source))?.source as ChannelKind | undefined) ?? "web" });
    const created = (task: AssistantTask) => { desk.createdTasks.add(task.id); return task; };
    const taskView = (task: AssistantTask) => ({ id: task.id, kind: task.kind, status: task.status, needs: task.needs, agent: task.productId, summary: task.summary, questions: task.payload.questions, error: task.lastError, updated_at: task.updatedAt });
    return [
      { name: "list_agents", label: "查看 Agent", description: "专家的全部 Agent：id、名字、承诺、状态、价格、开场问题，是否在线和待发布的改动（live），以及访谈大纲的进度。", parameters: Type.Object({}),
        execute: async () => ok(await Promise.all((await this.deps.catalog.list(accountId)).map(async agent => ({ ...agent, live: await this.deps.catalog.live(accountId, agent.productId), interview_outline: await this.interviewOutline(accountId, agent.productId) })))) },
      { name: "list_tasks", label: "查看事项", description: "还没结束的事：进行中的，和等专家回答、确认或卡住的。", parameters: Type.Object({}),
        execute: async () => ok((await this.deps.tasks.open(accountId)).map(taskView)) },
      { name: "create_agent", label: "新建 Agent", description: "为专家新建一个草稿 Agent。草稿不对外，不需要确认。", parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 240 }), promise: Type.String({ minLength: 1, maxLength: 2000, description: "一句话：这个 Agent 帮谁解决什么" }) }),
        execute: async (_id, raw) => { const input = raw as { name: string; promise: string }; return ok(await this.deps.catalog.create(accountId, input.name, input.promise)); } },
      { name: "propose_change", label: "提议修改", description: "改名字、承诺、价格、开场问题，或发布、下架产品（release）。这些对外可见，会先请专家确认，确认后才生效。pricing 的结构和 list_agents 返回的一致。", parameters: Type.Object({ agent_id: Type.String(), release: Type.Optional(Type.Union([Type.Literal("publish"), Type.Literal("withdraw")])), name: Type.Optional(Type.String({ maxLength: 240 })), promise: Type.Optional(Type.String({ maxLength: 2000 })), pricing: Type.Optional(Type.Any()), opening_questions: Type.Optional(Type.Any()) }),
        execute: async (_id, raw) => { const input = raw as { agent_id: string; release?: "publish" | "withdraw"; name?: string; promise?: string; pricing?: unknown; opening_questions?: unknown }; return ok(taskView(created(await this.propose(accountId, input.agent_id, { release: input.release, name: input.name, promise: input.promise, pricing: input.pricing, briefSpec: input.opening_questions }, origin())))); } },
      { name: "start_task", label: "派活", description: `派一件事，立刻返回，做完会告诉你。interview 例外：它接管和专家的对话，你这一轮随即结束，聊完才交回给你。${WORKER_KINDS.map(kind => this.workers[kind].about).join("；")}。`, parameters: Type.Object({ kind: Type.Union(WORKER_KINDS.map(kind => Type.Literal(kind))), agent_id: Type.Optional(Type.String()), instruction: Type.String({ minLength: 1, maxLength: 4000, description: "要做什么、专家的原话、为什么现在做" }) }),
        execute: async (_id, raw) => { const input = raw as { kind: WorkerKind; agent_id?: string; instruction: string }; return { ...ok(taskView(created(await this.dispatch(accountId, input.kind, input.agent_id, input.instruction, origin())))), terminate: this.workers[input.kind].handsOver }; } },
      { name: "exclude_source", label: "排除来源", description: "专家说某个来源不算数时调用。之后所有工作都不再采用它。", parameters: Type.Object({ source: Type.String({ minLength: 1, maxLength: 500 }), reason: Type.Optional(Type.String({ maxLength: 500 })) }),
        execute: async (_id, raw) => { const input = raw as { source: string; reason?: string }; await this.excludeSource(accountId, input.source, input.reason); return ok("已记下"); } },
      { name: "answer_task", label: "转交回答", description: "把专家对某件事的回答原样交回给它。", parameters: Type.Object({ task_id: Type.String(), answer: Type.String({ minLength: 1, maxLength: 20000 }) }),
        execute: async (_id, raw) => { const input = raw as { task_id: string; answer: string }; return ok(taskView(await this.answer(accountId, input.task_id, input.answer))); } },
      { name: "approve_task", label: "确认", description: "专家在对话里同意了某件需要确认的事。", parameters: Type.Object({ task_id: Type.String() }),
        execute: async (_id, raw) => ok(taskView(await this.approve(accountId, (raw as { task_id: string }).task_id))) },
      { name: "decline_task", label: "取消", description: "专家拒绝了某件需要确认的事，或某件卡住的事不再需要。", parameters: Type.Object({ task_id: Type.String() }),
        execute: async (_id, raw) => ok(taskView(await this.decline(accountId, (raw as { task_id: string }).task_id))) },
      { name: "poke", label: "戳一戳", description: "日常检查时决定问专家一个问题。记下问题，然后把问题本身作为你的回复。", parameters: Type.Object({ task_id: Type.String(), question: Type.String({ minLength: 1, maxLength: 500 }) }),
        execute: async (_id, raw) => { const input = raw as { task_id: string; question: string }; const task = await this.ownedTask(accountId, input.task_id); if (task.kind !== "poke") throw new Error("只有日常检查可以戳一戳"); return ok(taskView(await this.deps.tasks.update(task.id, { status: "needs_you", needs: "answer", payload: { ...task.payload, question: input.question } }))); } },
      { name: "finish_task", label: "结束", description: "结束一件事：日常检查决定今天不问；专家回答了戳一戳；或已经告诉专家的结果。", parameters: Type.Object({ task_id: Type.String(), answered: Type.Optional(Type.Boolean({ description: "专家回答了戳一戳的问题" })) }),
        execute: async (_id, raw) => { const input = raw as { task_id: string; answered?: boolean }; const task = await this.ownedTask(accountId, input.task_id); if (task.status === "working" && task.session) throw new Error("这件事还在进行中，不能结束"); return ok(taskView(await this.deps.tasks.update(task.id, { status: "done", ...(input.answered ? { answeredAt: new Date().toISOString() } : {}) }))); } },
    ];
  }

  private emit(accountId: string, event: Record<string, unknown>): void { this.events.emit("event", { accountId, ...event }); }
  private report(accountId: string, error: unknown): void { console.error(`[assistant ${accountId}]`, safeError(error)); }
}

function assistantDefinitions(): AgentDefinitionSource {
  const prompts = new Map<string, Promise<string>>();
  const prompt = (name: string) => {
    let pending = prompts.get(name);
    if (!pending) { pending = readFile(fileURLToPath(new URL(`../../prompts/assistant/${name}.md`, import.meta.url)), "utf8"); prompts.set(name, pending); }
    return pending;
  };
  const none = { required: [], normal: [], updates: [] };
  return {
    list: async () => [
      { role: "assistant" as const, systemPrompt: await prompt("ASSISTANT"), tools: ["list", "read", "web_search", "list_agents", "list_tasks", "create_agent", "propose_change", "start_task", "exclude_source", "answer_task", "approve_task", "decline_task", "poke", "finish_task"], dependencies: none },
      { role: "profile-research" as const, systemPrompt: await prompt("PROFILE_RESEARCH"), tools: ["list", "read", "write", "web_search", "web_scrape"], dependencies: none },
      { role: "content" as const, systemPrompt: await prompt("CONTENT"), tools: ["list", "read", "write"], dependencies: none },
    ],
  };
}

function deskState(session: Session): AssistantDeskState {
  session.assistantDesk ??= { ingress: [], seenEvents: [] };
  return session.assistantDesk;
}

type Incoming = Omit<IngressItem, "id" | "at"> & { id?: string };
type ExpertSource = "web" | ChannelKind;
const isChannel = (source: string): source is ChannelKind => (CHANNEL_KINDS as readonly string[]).includes(source);
const fromExpert = (item: Pick<IngressItem, "source">) => item.source === "web" || isChannel(item.source);
const spoken = (item: IngressItem) => item.text || "（发了一张图片）";

function render(item: IngressItem): string {
  if (item.source === "web") return `专家（Studio）：${spoken(item)}`;
  if (isChannel(item.source)) return `专家（${CHANNEL_LABELS[item.source]}）：${spoken(item)}`;
  if (item.source === "tick") return `[日常检查 · 任务 ${item.taskId}] ${item.text}`;
  return `[任务 ${item.taskId}] ${item.text}`;
}

function itemMessage(item: IngressItem): AgentMessage {
  return userMessage(render(item), item.images, fromExpert(item) ? { kind: "expert", itemId: item.id, text: item.text, images: item.images, ...(item.attachments?.length ? { attachments: item.attachments } : {}) } : { kind: "system", itemId: item.id });
}

const originOf = (message: AgentMessage) => (message as { origin?: MessageOrigin }).origin;

function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block): block is { type: "text"; text: string } => block?.type === "text").map(block => block.text).join("");
}

/** The last thing the agent said in a turn. */
function finalText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return "";
    if (message.role === "assistant") { const text = textOf(message).trim(); if (text) return text; }
  }
  return "";
}

function trailingQuestions(messages: AgentMessage[]): string[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return [];
    const details = (message as { details?: { type?: string; questions?: Array<{ question: string }> } }).details;
    if (message.role === "toolResult" && details?.type === "askuser") return (details.questions ?? []).map(question => question.question);
  }
  return [];
}

function relayedMessage(text: string): AgentMessage {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "hatch", model: "interview-relay", usage: zero, stopReason: "stop", timestamp: Date.now() } as AgentMessage;
}

async function outputText(store: WorkbenchStore, sessionId: string, file: string): Promise<string> {
  try { return (await store.read(sessionId, file)).bytes.toString("utf8"); } catch { return ""; }
}

const safeName = (name: string): string => name.normalize("NFC").replace(/[\\/:\x00-\x1f]+/g, "-").replace(/^\.+/, "").slice(-120) || "file";

function excerpt(text: string): string { return text.length > 1500 ? `${text.slice(0, 1500).trimEnd()}…` : text; }
function lease(): string { return new Date(Date.now() + WORKER_LEASE_MS).toISOString(); }

/** What the Expert sees when a file can't be read. The cause goes to the server log, never to the Expert. */
function unreadableFile(): Error {
  return Object.assign(new Error("这个文件我没读出内容。可以再发一次，或者换个格式；扫描版 PDF 我还读不了。"), { status: 422, code: "file_unreadable" });
}

function outlineText(todos: Todo[]): string {
  if (!todos.length) return "";
  return `\n\n大纲：\n${todos.map(todo => `${todo.status === "completed" ? "✓" : "○"} ${todo.title}`).join("\n")}`;
}
