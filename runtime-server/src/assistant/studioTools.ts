import { z } from "zod";
import type { HostToolRunner } from "../serverTools.js";
import { describeTool, type ClientGroup } from "../surfaces/contract.js";
import type { ToolDefinition } from "../tools.js";
import type { WebScrapeProvider } from "../factoryAgents/webTypes.js";
import type { Todo } from "../factoryAgents/store.js";
import type { AgentChange, CatalogAgent } from "./catalog.js";
import type { AssistantTask, TaskOrigin } from "./tasks.js";

/** Studio is operated from these clients. A Product's customers never reach it. */
export const STUDIO_CLIENTS: readonly ClientGroup[] = ["web", "cli", "mcp", "im"];

export const WORKER_KINDS = ["interview", "content", "research", "agent_research", "build", "evaluate"] as const;
export type WorkerKind = typeof WORKER_KINDS[number];

/** An Agent as the Assistant sees it: what it promises, whether it is live, and how far its interview has got. */
export type AgentOverview = CatalogAgent & { live: unknown; interview_outline: Todo[] };

/** What the Studio tools need from the Assistant: operating the Expert's Products and tasks. */
export interface StudioOperations {
  agents(accountId: string): Promise<AgentOverview[]>;
  openTasks(accountId: string): Promise<AssistantTask[]>;
  createAgent(accountId: string, name: string, promise: string): Promise<unknown>;
  propose(accountId: string, productId: string, change: AgentChange, origin: TaskOrigin): Promise<AssistantTask>;
  dispatch(accountId: string, kind: WorkerKind, productId: string | undefined, instruction: string, origin: TaskOrigin): Promise<AssistantTask>;
  /** One line per kind, for the start_task description. */
  describeWorker(kind: WorkerKind): string;
  /** Whether the kind works on one Agent, so it must be told which. */
  needsAgent(kind: WorkerKind): boolean;
  /** Marks one item of an Agent's interview outline done. Returns the outline. */
  tickOutline(accountId: string, productId: string, item: string): Promise<Todo[]>;
  excludeSource(accountId: string, source: string, reason?: string): Promise<void>;
  answer(accountId: string, taskId: string, text: string, key: string): Promise<AssistantTask>;
  /** `key` is the decider's: the same decision under it again is the same decision, not a second one. */
  approve(accountId: string, taskId: string, key: string): Promise<AssistantTask>;
  decline(accountId: string, taskId: string, key: string): Promise<AssistantTask>;
  poke(accountId: string, taskId: string, question: string): Promise<AssistantTask>;
  finish(accountId: string, taskId: string, answered: boolean): Promise<AssistantTask>;
  /** Public web evidence: links and snippets, no generated answer. */
  searchWeb(input: { query: string; max_results?: number; domains?: string[]; topic?: "general" | "news" }, signal?: AbortSignal): Promise<unknown>;
  /** One public page's main text as Markdown, with its URL. */
  readPage(url: string, signal?: AbortSignal): Promise<unknown>;
  /** Adds material the Expert sent to the Agent: plain text into its manual input, anything more complex and links to Ingest. Returns where each item went. */
  addToAgent(accountId: string, productId: string, input: { files: string[]; links: string[]; context?: string }): Promise<string[]>;
  /** Remembers the Run a task was created in, so that Run's reply can offer its buttons. */
  inRun(task: AssistantTask, runId: string): Promise<AssistantTask>;
}

/** Who is calling: the Run it belongs to, and where the Expert last spoke. */
export type StudioCall = { accountId: string; runId: string; origin: () => Promise<TaskOrigin>; signal?: AbortSignal };

export type StudioTool = {
  name: string;
  description: string;
  /** Running it again changes nothing, so a Run that used only such tools can restart. */
  readOnly: boolean;
  schema: z.ZodObject;
  run(call: StudioCall, args: Record<string, unknown>): Promise<Record<string, unknown>>;
};

const text = (min: number, max: number) => z.string().min(min).max(max);

const taskView = (task: AssistantTask) => ({ id: task.id, kind: task.kind, status: task.status, needs: task.needs, agent: task.productId, summary: task.summary, questions: task.payload.questions, error: task.lastError, updated_at: task.updatedAt });

/** Why an Agent may not be built yet, or undefined when its interview is finished and confirmed (every outline item ✓). */
const notReadyToBuild = (agent: AgentOverview): string | undefined => {
  const open = agent.interview_outline.filter(item => item.status !== "completed").map(item => item.title);
  if (!agent.interview_outline.length) return `「${agent.name}」还没有访谈大纲，不能构建。先派 interview 写大纲，再去问专家。`;
  if (open.length) return `「${agent.name}」的访谈大纲还有没聊完的：${open.join("、")}。构建只依据专家确认过的访谈：接着问专家，聊完一项勾一项（tick_outline）。`;
};

/** The Agent a task is about: the one named (by id or by name), else the only one the Expert has. */
const targetAgent = (agents: AgentOverview[], agentId: string | undefined): { agent?: AgentOverview; refusal?: string } => {
  const named = agentId?.trim();
  if (named) {
    const found = agents.find(agent => agent.productId === named) ?? agents.find(agent => agent.name === named);
    return found ? { agent: found } : { refusal: `没有这个 Agent：${named}。${agentChoices(agents)}` };
  }
  if (agents.length === 1) return { agent: agents[0] };
  return { refusal: agents.length ? `这件事要指定 Agent。${agentChoices(agents)}` : "专家还没有 Agent，先用 create_agent 建一个。" };
};

const agentChoices = (agents: AgentOverview[]) => `专家有这几个（名字 → id）：${agents.map(agent => `「${agent.name}」 → ${agent.productId}`).join("；")}。请再调用一次，把 agent_id 设成其中一个。`;

const agentFor = async (ops: StudioOperations, accountId: string, agentId: unknown): Promise<string> => {
  const { agent, refusal } = targetAgent(await ops.agents(accountId), agentId as string | undefined);
  if (refusal) throw new Error(refusal);
  return agent!.productId;
};

/** Longest page text handed to the model; the rest is dropped and said so. */
export const PAGE_TEXT_LIMIT = 50_000;

/** Reads one page through the scrape port Workers use. */
export async function readPage(scraper: WebScrapeProvider, url: string, signal?: AbortSignal) {
  const page = await scraper.scrape({ url, extractDepth: "advanced", format: "markdown" }, AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(90_000)]));
  return { url: page.url, title: page.title, retrieved_at: page.retrievedAt, text: page.content.slice(0, PAGE_TEXT_LIMIT), ...(page.content.length > PAGE_TEXT_LIMIT ? { truncated: true, total_chars: page.content.length } : {}) };
}

const done = (value: unknown): Record<string, unknown> => ({ output: typeof value === "string" ? value : JSON.stringify(value) });

/** The Assistant's tools, declared once: the set and its order never change within a conversation. */
export function studioTools(ops: StudioOperations): StudioTool[] {
  const created = async (call: StudioCall, task: AssistantTask) => taskView(await ops.inRun(task, call.runId));
  return [
    { name: "search_web", readOnly: true,
      schema: z.object({ query: text(1, 500), max_results: z.number().int().min(1).max(10).optional(), domains: z.array(z.string()).max(10).optional(), topic: z.enum(["general", "news"]).optional() }).strict(),
      description: "搜公开网页，返回来源链接和摘要，不是核实过的全文，也不生成回答。需要很快查一个事实时直接用。",
      run: async (call, args) => done(await ops.searchWeb(args as { query: string; max_results?: number; domains?: string[]; topic?: "general" | "news" }, call.signal)) },
    { name: "read_page", readOnly: true, schema: z.object({ url: text(1, 2000) }).strict(),
      description: "读一个公开网页的正文（Markdown），带原网址。专家要看某篇文章、某个页面的全文时用；搜索结果只有摘要。读不了登录后的页面，也不转写视频。",
      run: async (call, args) => done(await ops.readPage(String(args.url), call.signal)) },
    { name: "list_agents", readOnly: true, schema: z.object({}).strict(),
      description: "专家的全部 Agent：id、名字、承诺、状态、价格、开场问题，是否在线和待发布的改动（live），以及访谈大纲的进度。",
      run: async call => done(await ops.agents(call.accountId)) },
    { name: "list_tasks", readOnly: true, schema: z.object({}).strict(),
      description: "还没结束的事：进行中的，和等专家回答、确认或卡住的。",
      run: async call => done((await ops.openTasks(call.accountId)).map(taskView)) },
    { name: "create_agent", readOnly: false, schema: z.object({ name: text(1, 240), promise: text(1, 2000).describe("一句话：这个 Agent 帮谁解决什么") }).strict(),
      description: "为专家新建一个草稿 Agent。草稿不对外，不需要确认。",
      run: async (call, args) => done(await ops.createAgent(call.accountId, String(args.name), String(args.promise))) },
    { name: "propose_change", readOnly: false,
      schema: z.object({ agent_id: z.string(), release: z.enum(["publish", "withdraw"]).optional(), name: z.string().max(240).optional(), promise: z.string().max(2000).optional(), pricing: z.any().optional(), opening_questions: z.any().optional() }).strict(),
      description: "改名字、承诺、价格、开场问题，或发布、下架产品（release）。这些对外可见，会先请专家确认，确认后才生效。pricing 的结构和 list_agents 返回的一致。",
      run: async (call, args) => {
        const input = args as { agent_id: string; release?: "publish" | "withdraw"; name?: string; promise?: string; pricing?: unknown; opening_questions?: unknown };
        return done(await created(call, await ops.propose(call.accountId, input.agent_id, { release: input.release, name: input.name, promise: input.promise, pricing: input.pricing, briefSpec: input.opening_questions }, await call.origin())));
      } },
    { name: "start_task", readOnly: false,
      schema: z.object({ kind: z.enum(WORKER_KINDS), agent_id: z.string().optional().describe("要做哪个 Agent 的事：Agent 的 id，或它的名字。interview、build、content、evaluate、agent_research 在专家有两个以上 Agent 时必填；只有一个 Agent 时可省；research 不用写"), instruction: text(1, 4000).describe("要做什么、专家的原话、为什么现在做") }).strict(),
      description: `派一件事，立刻返回，做完会告诉你。派活的这一轮不写预告，也不写"我这就""接下来"这类话。interview 只写访谈大纲，不和专家说话；大纲写好会告诉你，之后由你来问专家。build 只在这个 Agent 的访谈大纲全是 ✓ 后才会接受。专家有两个以上 Agent 时，除 research 外都必须写 agent_id（id 或名字，用 list_agents 看）；只有一个时可以不写。${WORKER_KINDS.map(kind => ops.describeWorker(kind)).join("；")}。`,
      run: async (call, args) => {
        const input = args as { kind: WorkerKind; agent_id?: string; instruction: string };
        let agentId = input.agent_id;
        if (ops.needsAgent(input.kind)) {
          const agents = await ops.agents(call.accountId);
          const { agent, refusal } = targetAgent(agents, agentId);
          if (refusal) throw new Error(refusal);
          agentId = agent?.productId ?? agentId;
          const unready = input.kind === "build" && agent ? notReadyToBuild(agent) : undefined;
          if (unready) throw new Error(unready);
        }
        const task = await ops.dispatch(call.accountId, input.kind, agentId, input.instruction, await call.origin());
        return done(await created(call, task));
      } },
    { name: "tick_outline", readOnly: false,
      schema: z.object({ agent_id: z.string().optional().describe("Agent 的 id 或名字；专家只有一个 Agent 时可省"), item: text(1, 160).describe("大纲里这一项的标题（照 list_agents 里的写，写一段能唯一对上的就行）") }).strict(),
      description: "勾掉访谈大纲里的一项：只有专家自己的话已经满足提示词里「聊完的标准」，这一项才算聊完。没满足就不要勾，继续追问。大纲全勾完才能派 build。",
      run: async (call, args) => done({ outline: await ops.tickOutline(call.accountId, await agentFor(ops, call.accountId, args.agent_id), String(args.item)) }) },
    { name: "add_to_agent", readOnly: false,
      schema: z.object({ agent_id: z.string().optional().describe("Agent 的 id 或名字；专家只有一个 Agent 时可省"), files: z.array(z.string()).max(20).optional().describe("专家发来的文件在对话里显示的路径"), links: z.array(z.string()).max(20).optional().describe("要抓取的网页链接"), context: text(1, 2000).optional().describe("这些资料是什么、为什么给") }).strict(),
      description: "专家发来的文件或链接，按常识（看文件名和内容）明显属于某个 Agent 的资料时，加进它的资料；只是发来随便看看的，留在对话里，什么都不用做。放在哪里是自动的，不用你选。",
      run: async (call, args) => {
        const input = args as { files?: string[]; links?: string[]; context?: string };
        if (!input.files?.length && !input.links?.length) throw new Error("files 和 links 至少要给一个。");
        return done({ went: await ops.addToAgent(call.accountId, await agentFor(ops, call.accountId, args.agent_id), { files: input.files ?? [], links: input.links ?? [], context: input.context }) });
      } },
    { name: "exclude_source", readOnly: false, schema: z.object({ source: text(1, 500), reason: z.string().max(500).optional() }).strict(),
      description: "专家说某个来源不算数时调用。之后所有工作都不再采用它。",
      run: async (call, args) => { await ops.excludeSource(call.accountId, String(args.source), args.reason as string | undefined); return done("已记下"); } },
    { name: "answer_task", readOnly: false, schema: z.object({ task_id: z.string(), answer: text(1, 20000) }).strict(),
      description: "把专家对某件事的回答原样交回给它。",
      run: async (call, args) => done(taskView(await ops.answer(call.accountId, String(args.task_id), String(args.answer), `run:${call.runId}:answer:${args.task_id}`))) },
    { name: "approve_task", readOnly: false, schema: z.object({ task_id: z.string() }).strict(),
      description: "专家在对话里同意了某件需要确认的事。",
      run: async (call, args) => done(taskView(await ops.approve(call.accountId, String(args.task_id), `run:${call.runId}:approve:${args.task_id}`))) },
    { name: "decline_task", readOnly: false, schema: z.object({ task_id: z.string() }).strict(),
      description: "专家拒绝了某件需要确认的事，或某件卡住的事不再需要。",
      run: async (call, args) => done(taskView(await ops.decline(call.accountId, String(args.task_id), `run:${call.runId}:decline:${args.task_id}`))) },
    { name: "poke", readOnly: false, schema: z.object({ task_id: z.string(), question: text(1, 500) }).strict(),
      description: "日常检查时决定问专家一个问题。记下问题，然后把问题本身作为你的回复。",
      run: async (call, args) => done(taskView(await ops.poke(call.accountId, String(args.task_id), String(args.question)))) },
    { name: "finish_task", readOnly: false, schema: z.object({ task_id: z.string(), answered: z.boolean().optional().describe("专家回答了戳一戳的问题") }).strict(),
      description: "结束一件事：日常检查决定今天不问；专家回答了戳一戳；或已经告诉专家的结果。",
      run: async (call, args) => done(taskView(await ops.finish(call.accountId, String(args.task_id), args.answered === true))) },
  ];
}

/** The registry entry of each Studio tool, as the attachment tools have theirs: server-side, with the clients that may run it. */
export const studioToolDefinitions = (tools: readonly StudioTool[]): ToolDefinition[] => tools.map(tool => {
  const schema = z.toJSONSchema(tool.schema) as { properties?: Record<string, unknown>; required?: string[] };
  return {
    name: `studio.${tool.name}`,
    locality: "server",
    approval: "none",
    readOnly: tool.readOnly,
    supportedClients: STUDIO_CLIENTS,
    description: tool.description,
    schema: z.object({}).passthrough(),
    model: {
      name: tool.name,
      locality: "server",
      description: describeTool({ name: tool.name, description: tool.description, supportedClients: STUDIO_CLIENTS }),
      properties: schema.properties ?? {},
      required: schema.required ?? []
    }
  };
});

export const studioToolNames = (tools: readonly StudioTool[]): string[] => tools.map(tool => `studio.${tool.name}`);

/** The Studio tools of one Run, bound to the account it serves: a call never names whose data it touches. */
export class StudioToolRunner implements HostToolRunner {
  private readonly byName: Map<string, StudioTool>;
  constructor(tools: readonly StudioTool[], private readonly call: Omit<StudioCall, "signal">) { this.byName = new Map(tools.map(tool => [tool.name, tool])); }

  async run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const tool = this.byName.get(name);
    if (!tool) throw new Error(`No Studio tool: ${name}`);
    return tool.run({ ...this.call, signal }, tool.schema.parse(args));
  }
}
