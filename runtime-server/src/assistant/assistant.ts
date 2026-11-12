import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { WorkbenchStore, type AgentDefinitionSource, type AssistantRole, type Role, type Session, type Todo, type WorkbenchBackend } from "../factoryAgents/store.js";
import { WorkbenchRuntime, safeError, type WorkbenchRuntimeOptions } from "../factoryAgents/runtime.js";
import type { FactoryWorkspace } from "../factoryAgents/service.js";
import type { AgentCatalog, AgentChange } from "./catalog.js";
import { scrapeProviderFrom } from "../factoryAgents/webProviders.js";
import type { WebSearchProvider } from "../factoryAgents/webTypes.js";
import { CHANNEL_KINDS, type ChannelKind, type OutboundMessage } from "../channels/types.js";
import type { AssistantChannels } from "../channels/ports.js";
import { localDate, localHour, type AccountReach } from "./reach.js";
import type { RunFailure } from "../factoryAgents/runFailure.js";
import type { PublicMessage } from "../conversations/conversation.js";
import type { ContentPart } from "../surfaces/contract.js";
import type { SentMessage, UploadedRef } from "../chat/gateway.js";
import type { AssistantTask, TaskDecision, TaskKind, TaskOrigin, TaskRepository } from "./tasks.js";
import type { AssistantChat, ReplySteps } from "./chat.js";
import type { DeliveryRepository } from "./deliveries.js";
import type { ExpertMaterials } from "./materials.js";
import { SYSTEM_MESSAGE_PREFIX, isSystemMessageId } from "./systemMessage.js";
import { ChatError } from "../chat/principal.js";
import type { AssistantStateRepository } from "./state.js";
import type { Material } from "./materials.js";
import type { IngestJob } from "../ingest/job.js";
import { readPage, type AgentOverview, type StudioOperations, type WorkerKind } from "./studioTools.js";
import { log } from "../observability/log.js";
import { modelRole } from "../modelRoles.js";

const WORKER_LEASE_MS = 35 * 60_000;
const RUN_END = new Set(["voice.run_completed", "voice.run_failed", "voice.run_interrupted"]);
/** Where the Expert's own notes and the Assistant's findings live in its workspace; the files the Expert sent live in the conversation. */
const MATERIALS = "input/materials/";
const REVIEW_LABELS: Partial<Record<TaskKind, [string, string]>> = {
  content: ["定稿", "不要"], change: ["确认", "取消"],
};
/** How long after the Expert last spoke in Studio the Assistant does not also message them elsewhere. */
const STUDIO_ACTIVE_MS = 10 * 60_000;
const DELIVERY_POLL_MS = 2_000;
const OWED_MS = 24 * 3600_000;
const OWED_BATCH = 100;

export type { WorkerKind };
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
};

export type ProductWorkspaces = {
  workspace(scope: { creatorId: string; productId: string }, token: string): Promise<FactoryWorkspace>;
  attachAssistant(hooks: { withheldTools: (scope: { creatorId: string; productId: string }, session: Session) => Promise<string[]>; opened: (scope: { creatorId: string; productId: string }, workspace: FactoryWorkspace) => void }): void;
};

/** Where the Assistant hands material that needs converting; Ingest is what answers. */
export interface AssistantIngest {
  submit(accountId: string, productId: string, items: Array<{ url: string } | { name: string; content_base64: string; media_type: string }>, context?: string): Promise<{ id: string; status: string }>;
}

export type AssistantDependencies = {
  tasks: TaskRepository;
  reach: AccountReach;
  /** Where its messages go: the channel layer, which knows every platform so the Assistant knows none. */
  channels: Pick<AssistantChannels, "push" | "canReach">;
  products: ProductWorkspaces;
  catalog: AgentCatalog;
  /** The Assistant workspace of one account: its notes and the sessions of the workers it runs itself. */
  backend: (accountId: string) => WorkbenchBackend;
  /** What the Assistant knows about an Expert beyond the conversation: where the Expert last spoke. */
  state: AssistantStateRepository;
  /** Replies it owes for Runs it started on its own. */
  deliveries: DeliveryRepository;
  /** Runs fn only if this process holds the named cluster-wide lock. */
  exclusive: (name: string, fn: () => Promise<void>) => Promise<void>;
  /** Where its public web searches go. */
  search: WebSearchProvider;
  env: NodeJS.ProcessEnv;
  runtime?: Pick<WorkbenchRuntimeOptions, "agentFactory" | "deadlineMs" | "maxTurns">;
  ingest?: AssistantIngest;
};

/** One workspace per account: where the Assistant's workers run, and its notes. The conversation is Chat's. */
type Desk = {
  accountId: string;
  store: WorkbenchStore;
  runtime: WorkbenchRuntime;
  /** The Assistant's notes: findings and the Expert's say-so about sources, kept as files workers can read. */
  sessionId: string;
};

type ExpertSource = "web" | ChannelKind;
/** Plain text is told by the file as sent: its type (text/*, JSON) or its extension. A picture never is, nor is HTML. */
const PLAIN_TEXT_EXTENSION = /\.(txt|md|markdown|csv|tsv|json|log)$/i;
const isPlainText = ({ kind, bytes, original }: Material): boolean =>
  kind === "file" && bytes !== undefined && ((/^text\//.test(original.mimeType) && original.mimeType !== "text/html") || original.mimeType === "application/json" || PLAIN_TEXT_EXTENSION.test(original.name));
const isChannel = (source: string): source is ChannelKind => (CHANNEL_KINDS as readonly string[]).includes(source);

/**
 * One Assistant per account. It talks with the Expert, routes work to workbench sessions and turns their results back
 * into short replies. It never does the work itself. Its conversation is a conversation on Chat, hosted by `AssistantChat`;
 * this class is what the conversation operates: the Expert's Agents, tasks and workers.
 */
export class AssistantService implements StudioOperations {
  private desks = new Map<string, Promise<Desk>>();
  private observed = new WeakSet<FactoryWorkspace>();
  private definitions: AgentDefinitionSource;
  private closing = false;
  private conversation?: { chat: AssistantChat; materials: ExpertMaterials };
  private deliveryLoop?: NodeJS.Timeout;
  /** Adding a worker means adding one entry here: the tool, dispatch and completion all read from it. */
  private workers: Record<WorkerKind, WorkerSpec> = {
    interview: {
      about: "interview 写这个 Agent 的访谈大纲，交给你去问专家（需要 agent_id）",
      needsAgent: true,
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
    this.definitions = assistantDefinitions();
    deps.products.attachAssistant({
      // Publishing is the Assistant's tool, after the Expert confirms. A build it started has no way to go live.
      withheldTools: async (_scope, session) => session.role === "generation" && (await this.deps.tasks.bySession(session.id))?.kind === "build" ? ["corpus_upload"] : [],
      opened: (scope, workspace) => this.observe(scope.creatorId, workspace),
    });
  }

  /** Joins the Assistant to its conversation, and starts paying what it owes Experts for the Runs it started on its own. */
  bind(chat: AssistantChat, materials: ExpertMaterials): void {
    this.conversation = { chat, materials };
    this.deliveryLoop = setInterval(() => void this.settleDeliveries().catch(error => this.report("deliveries", error)), DELIVERY_POLL_MS);
    this.deliveryLoop.unref();
  }

  private get chat(): AssistantChat {
    if (!this.conversation) throw new Error("The Assistant has no conversation yet.");
    return this.conversation.chat;
  }

  private get materials(): ExpertMaterials {
    if (!this.conversation) throw new Error("The Assistant has no conversation yet.");
    return this.conversation.materials;
  }

  // ── What the Expert says ───────────────────────────────────────────────

  /** Stop the Assistant's running turn. */
  stop(accountId: string): Promise<void> { return this.chat.stop(accountId); }

  /**
   * The Expert said something in a chat: it steers the Assistant's Run or starts one, atomically. `id` is the key a retry
   * reuses, so a platform event delivered twice is one message. `system` is for what the Expert did without typing it, such as a button.
   */
  async hear(accountId: string, input: { id: string; source: ExpertSource; parts: ContentPart[]; messageRef?: string; system?: boolean }): Promise<SentMessage> {
    // `sys:` ids are the Assistant's own to itself: a client's key cannot be one, or its message would be hidden as news.
    if (!input.system && isSystemMessageId(input.id)) throw new ChatError("invalid_message_id", `A message id cannot start with ${SYSTEM_MESSAGE_PREFIX}.`, 400);
    if (!input.system) await this.deps.state.expertSpoke(accountId, { source: input.source, at: new Date().toISOString(), ...(input.messageRef ? { messageRef: input.messageRef } : {}) });
    const client = { client: input.source === "web" ? "web" as const : "im" as const };
    return input.system ? this.chat.sayAsSystem(accountId, textOf(input.parts), input.id).then(sent => sent) : this.chat.say(accountId, { id: input.id, parts: input.parts, client });
  }

  /** A file or a picture the Expert sends becomes an attachment of the conversation, and a message may then refer to it. */
  upload(accountId: string, name: string, bytes: Buffer): Promise<UploadedRef> { return this.chat.upload(accountId, name, bytes); }

  /** The Expert sent a file or a picture from Studio's page. It becomes an attachment of the conversation, and the Assistant is told. */
  async receive(accountId: string, name: string, bytes: Buffer, source: ExpertSource, ref: { id?: string; messageRef?: string; caption?: string } = {}): Promise<{ name: string; sent: SentMessage }> {
    const { assetId, kind } = await this.upload(accountId, name, bytes);
    const caption = ref.caption?.trim();
    const sent = await this.hear(accountId, {
      id: ref.id ?? randomUUID(), source, ...(ref.messageRef ? { messageRef: ref.messageRef } : {}),
      parts: [...(caption ? [{ type: "text" as const, text: caption }] : []), { type: kind, assetId }]
    });
    return { name, sent };
  }

  /**
   * Task news the Assistant hears: what a worker finished, asked, or got stuck on. `event` names what happened to the task, so the
   * same news told again, as a replay does, is one message and one owed reply.
   */
  async news(accountId: string, taskId: string, text: string, event: string, kind: "task" | "tick" = "task"): Promise<void> {
    await this.hearSystem(accountId, kind === "tick" ? `[日常检查 · 任务 ${taskId}] ${text}` : `[任务 ${taskId}] ${text}`, taskId, `task:${taskId}:${event}`);
  }

  /** Ingest settled a job for one of the Expert's Agents, whoever submitted it: the Assistant hears what came of each item. */
  async ingested(job: IngestJob): Promise<void> {
    const items = job.items.map(item => `- ${"url" in item.input ? item.input.url : item.input.name}：${item.status === "failed" ? `没成，${item.error ?? "没有原因"}` : `${item.status === "partial" ? "部分完成，" : ""}已放进 ${item.markdown_path ?? item.original_ref}`}`);
    await this.hearSystem(job.accountId, `[资料 ${job.id} · Agent ${job.productId}] Ingest ${job.status === "failed" ? "没做成" : "做完了"}：\n${items.join("\n")}`, undefined, `ingested:${job.id}`);
  }

  private async hearSystem(accountId: string, text: string, taskId?: string, key?: string): Promise<void> {
    const sent = await this.chat.sayAsSystem(accountId, text, key);
    // The reply to news is the Assistant's own to send, unless the news joined a Run that has its own reply path.
    // A replay owes it too: the first try may have stopped between saying and owing, and owing twice is one debt.
    if (sent.outcome === "started" || sent.outcome === "replayed") await this.deps.deliveries.owe(sent.runId, accountId);
    const task = taskId ? await this.deps.tasks.get(taskId) : undefined;
    if (task) await this.inRun(task, sent.runId);
  }

  /** The chat shows what was said; the buttons under the Assistant's reply are the tasks that wait for the Expert's decision. */
  async reviewButtons(runId: string): Promise<NonNullable<OutboundMessage["buttons"]>> {
    const buttons: NonNullable<OutboundMessage["buttons"]> = [];
    for (const task of await this.deps.tasks.byRun(runId)) {
      const labels = REVIEW_LABELS[task.kind];
      if (task.status !== "needs_you" || task.needs !== "review" || !labels) continue;
      buttons.push({ label: labels[0], taskId: task.id, action: "approve" }, { label: labels[1], taskId: task.id, action: "decline" });
    }
    return buttons.slice(0, 4);
  }

  /**
   * The reply to a Run the Assistant started on its own goes where the Expert was last, unless they are in Studio now,
   * where it is already on the page. The reply is queued under the Run's own key, so any number of instances, and any retry
   * after a crash, queue it once; the debt is closed only after it is queued. With no chat to take it, it stays owed.
   */
  async settleDeliveries(): Promise<void> {
    if (this.closing || !this.conversation) return;
    for (const owed of await this.deps.deliveries.open(OWED_BATCH)) await this.settleDelivery(owed).catch(error => this.report(owed.accountId, error));
  }

  private async settleDelivery({ runId, accountId, createdAt }: { runId: string; accountId: string; createdAt: string }): Promise<void> {
    const { deliveries } = this.deps;
    const progress = await this.chat.gateway.progress(runId);
    if (progress && !progress.ended) return;
    if (!progress) return deliveries.done(runId);
    const { status, text, reason } = progress.reply;
    const message = status === "completed" ? text.trim() : status === "failed" ? `我这边出了点问题，刚才那条没处理完：${reason ?? "未知错误"}` : "";
    const last = await this.deps.state.lastExpert(accountId);
    if (!message || (last?.source === "web" && Date.now() - Date.parse(last.at) < STUDIO_ACTIVE_MS)) return deliveries.done(runId);
    const buttons = await this.reviewButtons(runId);
    const queued = await this.deps.channels.push(accountId, { text: message, ...(buttons.length ? { buttons } : {}) }, last && isChannel(last.source) ? last.source : undefined, `assistant-run:${runId}`);
    // No chat can take it yet: it stays owed for a day, then it is old news.
    if (queued || Date.now() - Date.parse(createdAt) > OWED_MS) await deliveries.done(runId);
  }

  /** A file's text in the Agent's manual input: where plain text goes. */
  private async writeManual(workspace: FactoryWorkspace, material: Material): Promise<string> {
    const path = `input/manual/${material.name}`;
    await workspace.store.backend.writeManual(path, material.bytes!);
    return path;
  }

  /** The materials the Assistant named by the path it saw; a path that is not one is refused with the paths that are. */
  private async sent(accountId: string, paths: string[]): Promise<Material[]> {
    const all = await this.materials.list(accountId);
    return paths.map(path => {
      const found = all.find(material => material.chatPath === path);
      if (!found) throw new Error(`专家没有发过这个文件：${path}。发过的有：${all.map(material => material.chatPath).join("、") || "没有"}。`);
      return found;
    });
  }

  /**
   * Material the Expert sent becomes the Agent's by its form, never by judgement: plain text is written into the
   * manual input now; anything more complex, and every link, goes to Ingest as one job. All or nothing: when Ingest
   * is needed and not configured, nothing is written. Returns where each item went.
   */
  async addToAgent(accountId: string, productId: string, input: { files: string[]; links: string[]; context?: string }): Promise<string[]> {
    const materials = await this.sent(accountId, input.files);
    const plain = materials.filter(isPlainText);
    const complex = materials.filter(material => !isPlainText(material));
    const ingested = [...complex.map(material => material.chatPath), ...input.links];
    if (ingested.length && !this.deps.ingest) throw new Error(`Ingest 没有配置，收不了：${ingested.join("、")}。这次什么都没有加进资料。`);
    const workspace = await this.workspace(accountId, productId);
    const went = await Promise.all(plain.map(async material => `${material.chatPath} → ${await this.writeManual(workspace, material)}`));
    if (!ingested.length) return went;
    const originals = await Promise.all(complex.map(async ({ original }) => ({ name: original.name, content_base64: (await original.read()).toString("base64"), media_type: original.mimeType })));
    const { id } = await this.deps.ingest!.submit(accountId, productId, [...originals, ...input.links.map(url => ({ url }))], input.context);
    return [...went, ...ingested.map(item => `${item} → ingest job ${id}，整理好会放进 input/manual`)];
  }

  /** The interview worker wrote the outline and stopped: the Assistant now asks the Expert and ticks it off. */
  private async interviewTurnEnded(task: AssistantTask, workspace: FactoryWorkspace, type: string): Promise<void> {
    const voice = await workspace.store.get(task.session!.sessionId);
    await workspace.store.update(voice.id, s => { if (s.assistantTaskId === task.id) delete s.assistantTaskId; });
    if (type !== "voice.run_completed") return this.block(task, voice.error ?? "访谈大纲没写成", voice.messages.length);
    await this.deps.tasks.update(task.id, { status: "done", leaseExpiresAt: undefined });
    await this.news(task.accountId, task.id, `访谈大纲写好了。接下来你自己在对话里一个一个问专家，用 tick_outline 勾掉聊完的项。${outlineText(voice.todos)}`, `finished:${voice.messages.length}`);
  }

  // ── Tasks ──────────────────────────────────────────────────────────────

  describeWorker(kind: WorkerKind): string { return this.workers[kind].about; }
  needsAgent(kind: WorkerKind): boolean { return Boolean(this.workers[kind].needsAgent); }

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
    const workspace = await this.workspace(accountId, productId);
    const voice = (await workspace.store.list()).find(session => session.role === "voice") ?? await workspace.store.create("voice");
    if (workspace.runtime.isRunning(voice.id)) throw new Error("这个 Agent 的访谈正在 Studio 里进行，稍后再试");
    const task = await this.deps.tasks.create({ accountId, productId, kind, origin, session: { scope: "product", sessionId: voice.id }, payload: { instruction }, summary: `写「${input.agentName}」的访谈大纲`, leaseExpiresAt: lease() });
    await workspace.store.update(voice.id, s => { s.assistantTaskId = task.id; });
    await workspace.runtime.start(voice.id, `[Hatch 助理请你写访谈大纲]\n\n要了解的：${instruction}`);
    return task;
  }

  /** The Assistant's judgement that one outline item is done. The outline is the interview session's todo list, the same one the interview worker writes. */
  async tickOutline(accountId: string, productId: string, item: string): Promise<Todo[]> {
    const workspace = await this.workspace(accountId, productId);
    const voice = (await workspace.store.list()).find(session => session.role === "voice");
    const wanted = item.trim();
    const matches = (voice?.todos ?? []).filter(todo => todo.title === wanted || todo.title.includes(wanted));
    if (matches.length !== 1) throw new Error(`${matches.length ? "这个说法对应不止一项" : "大纲里没有这一项"}：${wanted}。大纲现在是：${(voice?.todos ?? []).map(todo => todo.title).join("；") || "（空）"}`);
    await workspace.store.update(voice!.id, s => { s.todos = s.todos.map(todo => todo === matches[0] || todo.title === matches[0]!.title ? { ...todo, status: "completed" as const } : todo); });
    workspace.runtime.emit(voice!.id, "todos");
    return (await workspace.store.get(voice!.id)).todos;
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

  /** Copy the Assistant's notes into a Product's shared input, where its Agents read them. Files the Expert sent get there only through add_to_agent. */
  private async shareMaterials(accountId: string, productId: string): Promise<void> {
    const desk = await this.desk(accountId);
    const notes = (await desk.store.get(desk.sessionId)).files.filter(file => file.path.startsWith(MATERIALS));
    if (!notes.length) return;
    const workspace = await this.workspace(accountId, productId);
    for (const file of notes) {
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
    for (const material of (await this.materials.list(desk.accountId)).filter(candidate => candidate.kind === "file" && candidate.bytes)) {
      await desk.store.put(workerId, `${MATERIALS}${material.name}`, material.bytes!, { actor: "host", mimeType: material.mimeType });
    }
  }

  async propose(accountId: string, productId: string, change: AgentChange, origin: TaskOrigin): Promise<AssistantTask> {
    const agent = await this.deps.catalog.get(accountId, productId);
    if (!agent) throw new Error("没有找到这个 Agent");
    const fields = Object.keys(change).filter(key => change[key as keyof AgentChange] !== undefined);
    if (!fields.length) throw new Error("没有要改的内容");
    return this.deps.tasks.create({ accountId, productId, kind: "change", origin, status: "needs_you", needs: "review", payload: { change }, summary: change.release ? `${change.release === "publish" ? "发布" : "下架"}「${agent.name}」` : `修改「${agent.name}」：${fields.join("、")}` });
  }

  /**
   * The Expert's decision on a task, from a button, the page or the Assistant's tool. `key` is the decider's own, and deciding is
   * idempotent: the same decision again is a replay (nothing runs twice), the other one is refused (TaskRefused).
   */
  async decide(accountId: string, taskId: string, action: TaskDecision["action"], key: string): Promise<{ task: AssistantTask; replayed: boolean }> {
    await this.ownedTask(accountId, taskId);
    return this.deps.tasks.decide(taskId, { action, key }, async task => {
      if (action === "approve" && task.kind === "change") await this.deps.catalog.apply(accountId, task.productId!, task.payload.change as AgentChange);
    });
  }

  async approve(accountId: string, taskId: string, key: string): Promise<AssistantTask> { return (await this.decide(accountId, taskId, "approve", key)).task; }

  async decline(accountId: string, taskId: string, key: string): Promise<AssistantTask> { return (await this.decide(accountId, taskId, "decline", key)).task; }

  /** Give a waiting task the Expert's answer. */
  async answer(accountId: string, taskId: string, text: string): Promise<AssistantTask> {
    const task = await this.ownedTask(accountId, taskId);
    if (task.status !== "needs_you" || task.needs !== "answer") throw new Error("这件事现在不需要回答");
    if (task.kind === "poke") return this.deps.tasks.update(task.id, { status: "done", answeredAt: new Date().toISOString() });
    const runtime = await this.sessionRuntime(task);
    await runtime.start(task.session!.sessionId, text);
    return this.deps.tasks.update(task.id, { status: "working", leaseExpiresAt: lease() });
  }

  async openTasks(accountId: string): Promise<AssistantTask[]> { return this.deps.tasks.open(accountId); }

  /** Everything the Assistant knows of the Expert's Agents: what they promise, whether they are live, and how far their interview has got. */
  async agents(accountId: string): Promise<AgentOverview[]> {
    return Promise.all((await this.deps.catalog.list(accountId)).map(async agent => ({ ...agent, live: await this.deps.catalog.live(accountId, agent.productId), interview_outline: await this.interviewOutline(accountId, agent.productId) })));
  }

  createAgent(accountId: string, name: string, promise: string): Promise<unknown> { return this.deps.catalog.create(accountId, name, promise); }

  async poke(accountId: string, taskId: string, question: string): Promise<AssistantTask> {
    const task = await this.ownedTask(accountId, taskId);
    if (task.kind !== "poke") throw new Error("只有日常检查可以戳一戳");
    return this.deps.tasks.update(task.id, { status: "needs_you", needs: "answer", payload: { ...task.payload, question } });
  }

  async finish(accountId: string, taskId: string, answered: boolean): Promise<AssistantTask> {
    const task = await this.ownedTask(accountId, taskId);
    if (task.status === "working" && task.session) throw new Error("这件事还在进行中，不能结束");
    return this.deps.tasks.update(task.id, { status: "done", ...(answered ? { answeredAt: new Date().toISOString() } : {}) });
  }

  /** The Run a task was created or announced in, so that Run's reply can carry the task's buttons. */
  inRun(task: AssistantTask, runId: string): Promise<AssistantTask> { return this.deps.tasks.update(task.id, { payload: { ...task.payload, run: runId } }); }

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
    if (type !== "voice.run_completed") return void await this.block(task, session.error ?? "被中断了", session.messages.length);
    const questions = trailingQuestions(session.messages);
    if (questions.length) {
      await this.deps.tasks.update(task.id, { status: "needs_you", needs: "answer", leaseExpiresAt: undefined, payload: { ...task.payload, questions } });
      // Each question the worker asks is a turn of its own: the length of its session tells them apart, and tells a replay of one from the next.
      await this.news(task.accountId, task.id, `想问专家：\n${questions.map((question, index) => `${index + 1}. ${question}`).join("\n")}`, `asked:${session.messages.length}`);
      return;
    }
    const worker = this.workers[task.kind as WorkerKind];
    if (!worker) return void await this.block(task, `不认识的任务类型：${task.kind}`, session.messages.length);
    const next = worker.steps?.[worker.steps.indexOf(task.payload.step as Role) + 1];
    if (next) return void await this.runStep(task, next);
    await worker.finish(task, session, store);
  }

  /** The result waits for the Expert's decision. */
  private review(file: string, lead: string): WorkerFinish {
    return async (task, session, store) => {
      const body = await outputText(store, session.id, file);
      if (!body) return this.block(task, `没有写出 ${file}`, session.messages.length);
      await this.deps.tasks.update(task.id, { status: "needs_you", needs: "review", leaseExpiresAt: undefined, outputRef: `assistant:${session.id}:${file}` });
      await this.news(task.accountId, task.id, `${lead}\n${excerpt(body)}`, `finished:${session.messages.length}`);
    };
  }

  /** The work is done: tell the Assistant what came out. */
  private announce(lead: string, file?: string): WorkerFinish {
    return async (task, session, store) => {
      const body = file ? await outputText(store, session.id, file) : "";
      await this.deps.tasks.update(task.id, { status: "done", leaseExpiresAt: undefined, ...(file ? { outputRef: `product:${session.id}:${file}` } : {}) });
      await this.news(task.accountId, task.id, `${lead}\n${excerpt(body || finalText(session.messages))}`, `finished:${session.messages.length}`);
    };
  }

  private async finishResearch(task: AssistantTask, session: Session, store: WorkbenchStore): Promise<void> {
    const desk = await this.desk(task.accountId);
    const profile = await outputText(store, session.id, "output/PUBLIC_PROFILE.md");
    if (!profile.trim()) {
      await this.deps.tasks.update(task.id, { status: "done", leaseExpiresAt: undefined, summary: "没有读到公开资料" });
      await this.news(task.accountId, task.id, `没有读到公开资料。它的说明：${finalText(session.messages)}\n如实告诉专家是什么情况：搜索失败不等于网上没有。`, `finished:${session.messages.length}`);
      return;
    }
    await desk.store.put(desk.sessionId, `${MATERIALS}公开资料.md`, Buffer.from(profile), { actor: "host" });
    await this.deps.tasks.update(task.id, { status: "done", leaseExpiresAt: undefined, outputRef: `assistant:${desk.sessionId}:${MATERIALS}公开资料.md` });
    await this.news(task.accountId, task.id, `公开资料读完了：\n${excerpt(profile)}\n\n把发现自然地接进对话，告诉专家你看过哪些来源，他可以说哪篇不算数。`, `finished:${session.messages.length}`);
  }

  /** `turn` is what tells one block from the next: the worker's session length when its turn ended, or the attempt count. A retry of the same block has the same one. */
  private async block(task: AssistantTask, reason: string, turn: number): Promise<void> {
    await this.deps.tasks.update(task.id, { status: "needs_you", needs: "blocked", lastError: reason, leaseExpiresAt: undefined });
    await this.news(task.accountId, task.id, `卡住了：${reason}`, `blocked:${turn}`);
  }

  // ── Tick: recovery and the daily check ─────────────────────────────────

  async tick(now = new Date()): Promise<void> {
    await this.deps.exclusive("hatch-assistant-tick", async () => {
      for (const task of await this.deps.tasks.expired(now)) await this.recover(task).catch(error => this.report(task.accountId, error));
      for (const { accountId, timezone } of await this.deps.reach.assistantAccounts()) await this.dailyCheck(accountId, timezone, now).catch(error => this.report(accountId, error));
    });
  }

  private async recover(task: AssistantTask): Promise<void> {
    if (task.attempts >= 3) return this.block(task, "多次中断，没能完成", task.attempts);
    const runtime = await this.sessionRuntime(task);
    await this.deps.tasks.update(task.id, { attempts: task.attempts + 1, leaseExpiresAt: lease() });
    if (runtime.isRunning(task.session!.sessionId)) return;
    await runtime.start(task.session!.sessionId, "服务重启过，上一轮被中断了。先检查已有的结果，再从中断的地方继续。");
  }

  private async dailyCheck(accountId: string, timezone: string, now: Date): Promise<void> {
    const hour = localHour(timezone, now);
    if (hour < 10 || hour >= 20) return;
    // Never interrupt a live conversation: no check right after the Expert spoke.
    const last = await this.deps.state.lastExpert(accountId);
    if (last && now.getTime() - Date.parse(last.at) < 30 * 60_000) return;
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
    await this.news(accountId, task.id, `专家当地时间 ${clock}。看看他的 Agent 和最近的事，决定今天要不要戳一戳他。`, "tick", "tick");
  }

  // ── Studio and channel surfaces ───────────────────────────────────────

  /** What the chat shows: what the Expert said and what the Assistant said. System messages stay out. */
  async view(accountId: string, options: { limit?: number; beforeCursor?: string } = {}): Promise<{ has_more: boolean; before_cursor?: string; messages: Array<{ id: string; role: "expert" | "assistant"; text: string; at: string; state?: "queued"; images?: string[]; attachments?: NonNullable<PublicMessage["attachments"]>; /** What the Assistant did inside a reply, in order. */ steps?: ReplySteps }>; tasks: AssistantTask[]; running: boolean; runId?: string; /** Why the last turn failed, until the next one starts. */ failure?: RunFailure }> {
    const [{ messages: lines, has_more, before_cursor }, status] = await Promise.all([this.chat.shown(accountId, options), this.chat.status(accountId)]);
    return {
      has_more, ...(before_cursor ? { before_cursor } : {}),
      messages: lines.map(line => {
        const images = line.attachments?.filter(attachment => attachment.type === "image").map(attachment => `${attachment.asset_id}.jpg`);
        return { id: line.id, role: line.role === "user" ? "expert" as const : "assistant" as const, text: line.text, at: line.created_at, ...(line.state ? { state: line.state } : {}), ...(images?.length ? { images } : {}), ...(line.attachments?.length ? { attachments: line.attachments } : {}), ...(line.steps ? { steps: line.steps } : {}) };
      }),
      tasks: await this.deps.tasks.open(accountId),
      running: status.state === "running", ...(status.runId ? { runId: status.runId } : {}),
      ...(status.state === "failed" && status.error ? { failure: status.error } : {}),
    };
  }

  /** A picture the Expert sent, for the chat page. */
  image(accountId: string, assetId: string): Promise<{ bytes: Buffer; mime: string } | undefined> { return this.chat.image(accountId, assetId); }

  /** Public web evidence for the Assistant, from the provider the Registry is configured with. */
  searchWeb(input: { query: string; max_results?: number; domains?: string[]; topic?: "general" | "news" }, signal?: AbortSignal): Promise<unknown> {
    return this.deps.search.search(
      { query: input.query, maxResults: input.max_results ?? 6, includeDomains: input.domains, topic: input.topic, searchDepth: "advanced" },
      AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(90_000)])
    );
  }

  /** One page's full text, through the scrape provider Workers use. */
  readPage(url: string, signal?: AbortSignal): Promise<unknown> { return readPage(scrapeProviderFrom(this.deps.env), url, signal); }

  /** The Assistant's view of things right now. Rebuilt for every model call and never stored. */
  async liveState(accountId: string): Promise<string> {
    const tasks = await this.deps.tasks.open(accountId);
    const agents = await this.deps.catalog.list(accountId);
    const lines = await Promise.all(agents.map(async agent => {
      const live = await this.deps.catalog.live(accountId, agent.productId) as { is_live?: boolean; pending_changes?: string[]; public_url?: string; chat_url?: string; telegram_url?: string } | null;
      const outline = await this.interviewOutline(accountId, agent.productId);
      const links = live?.is_live ? [["主页", live.public_url], ["聊天页", live.chat_url], ["Telegram", live.telegram_url]].filter(([, url]) => url).map(([label, url]) => `${label} ${url}`) : [];
      return [`- 「${agent.name}」（${agent.productId}）：${live?.is_live ? "在线" : "未上线"}${live?.pending_changes?.length ? `，待发布：${live.pending_changes.join("、")}` : ""}${links.length ? `，${links.join("，")}` : ""}`, ...outline.map(todo => `  ${todo.status === "completed" ? "✓" : "○"} ${todo.title}`)].join("\n");
    }));
    return `<当前状态>\n系统自动生成，不是专家说的，不要复述。\n事项：\n${tasks.map(task => `- ${task.kind}（${task.id}）${task.status}${task.needs ? `/${task.needs}` : ""}：${task.summary ?? ""}`).join("\n") || "（没有）"}\nAgent 和访谈大纲：\n${lines.join("\n") || "（没有）"}\n</当前状态>`;
  }

  /** Someone linked their chat to this Assistant. Returns what to say to them. */
  async linked(accountId: string): Promise<string> {
    const known = (await this.deps.catalog.list(accountId)).length > 0;
    await this.chat.touch(accountId);
    return known ? "连上了。以后我会在这里找你，你也可以随时在这里跟我说话。" : "连上了。先给我一样东西就行：你的名字、一个链接，或者现成的资料。";
  }

  /** Resolves when the Studio Runs this process holds have ended. */
  async drain(): Promise<void> {
    for (const pending of this.desks.values()) await (await pending.catch(() => undefined))?.runtime.drain();
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.deliveryLoop) clearInterval(this.deliveryLoop);
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
    const notes = sessions.find(candidate => candidate.role === "assistant") ?? await store.create("assistant", "Hatch 助理");
    const runtime = new WorkbenchRuntime(store, { ...this.deps.runtime, env: { ...this.deps.env, HATCH_FACTORY_LLM_PROFILE: modelRole("worker", this.deps.env) } });
    const desk: Desk = { accountId, store, runtime, sessionId: notes.id };
    runtime.events.on("event", (event: { sessionId?: string; type?: string }) => {
      if (!event.sessionId || !event.type || !RUN_END.has(event.type)) return;
      void this.deps.tasks.bySession(event.sessionId).then(task => { if (task) return this.workerTurnEnded(task, store, undefined, event.type!); }).catch(error => this.report(accountId, error));
    });
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
      const text = message.role === "user" || message.role === "assistant" ? textOfMessage(message).trim() : "";
      return text ? [`**${message.role === "user" ? "专家" : "访谈"}**：${text}`] : [];
    }).join("\n\n");
    if (!transcript) throw new Error("这个 Agent 的访谈还是空的，先补访谈");
    await store.put(workerId, "input/interview/TRANSCRIPT.md", Buffer.from(transcript), { actor: "host" });
  }

  private report(scope: string, error: unknown): void { log.error("assistant_failed", { scope, error: safeError(error) }); }
}

/** The Assistant's own system prompt: its persona, and how it works with its tools. */
export async function assistantPrompt(): Promise<string> {
  const read = (name: string) => readFile(fileURLToPath(new URL(`../../prompts/assistant/${name}`, import.meta.url)), "utf8");
  return `${await read("ASSISTANT.md")}\n\n${await read("INTERVIEW_DONE.md")}`;
}

function assistantDefinitions(): AgentDefinitionSource {
  const prompts = new Map<string, Promise<string>>();
  const prompt = (name: string) => {
    let pending = prompts.get(name);
    if (!pending) { pending = readFile(fileURLToPath(new URL(`../../prompts/assistant/${name}.md`, import.meta.url)), "utf8"); prompts.set(name, pending); }
    return pending;
  };
  return {
    list: async () => [
      { role: "profile-research" as const, systemPrompt: await prompt("PROFILE_RESEARCH"), tools: ["list", "read", "write", "web_search", "web_scrape"] },
      { role: "content" as const, systemPrompt: await prompt("CONTENT"), tools: ["list", "read", "write"] },
    ],
  };
}

const textOf = (parts: ContentPart[]): string => parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");

function textOfMessage(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block): block is { type: "text"; text: string } => block?.type === "text").map(block => block.text).join("");
}

/** The last thing the agent said in a turn. */
function finalText(messages: Array<{ role: string; content?: unknown }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return "";
    if (message.role === "assistant") { const text = textOfMessage(message).trim(); if (text) return text; }
  }
  return "";
}

function trailingQuestions(messages: Array<{ role: string }>): string[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return [];
    const details = (message as { details?: { type?: string; questions?: Array<{ question: string }> } }).details;
    if (message.role === "toolResult" && details?.type === "askuser") return (details.questions ?? []).map(question => question.question);
  }
  return [];
}

async function outputText(store: WorkbenchStore, sessionId: string, file: string): Promise<string> {
  try { return (await store.read(sessionId, file)).bytes.toString("utf8"); } catch { return ""; }
}

function excerpt(text: string): string { return text.length > 1500 ? `${text.slice(0, 1500).trimEnd()}…` : text; }
function lease(): string { return new Date(Date.now() + WORKER_LEASE_MS).toISOString(); }

function outlineText(todos: Todo[]): string {
  if (!todos.length) return "";
  return `\n\n大纲：\n${todos.map(todo => `${todo.status === "completed" ? "✓" : "○"} ${todo.title}`).join("\n")}`;
}

