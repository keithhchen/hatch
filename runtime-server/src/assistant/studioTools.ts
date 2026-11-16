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

export const WORKER_KINDS = ["interview", "agent_research", "build", "evaluate"] as const;
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
  searchWeb(input: { query: string; objective: string }, signal?: AbortSignal): Promise<unknown>;
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

/** The Agent a task is about: the one named (by id or by name), else the only one the Expert has. */
const targetAgent = (agents: AgentOverview[], agentId: string | undefined): { agent?: AgentOverview; refusal?: string } => {
  const named = agentId?.trim();
  if (named) {
    const found = agents.find(agent => agent.productId === named) ?? agents.find(agent => agent.name === named);
    return found ? { agent: found } : { refusal: `No such Agent: ${named}. ${agentChoices(agents)}` };
  }
  if (agents.length === 1) return { agent: agents[0] };
  return { refusal: agents.length ? `An Agent must be specified for this. ${agentChoices(agents)}` : "The Expert has no Agent yet; create one with create_agent first." };
};

const agentChoices = (agents: AgentOverview[]) => `The Expert has these (name → id): ${agents.map(agent => `"${agent.name}" → ${agent.productId}`).join("; ")}. Call again with agent_id set to one of them.`;

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
      schema: z.object({ query: text(1, 500).describe("A keyword-style query: a few distinctive words"), objective: text(1, 1000).describe("What this search must find out, and which kinds of sources should rank first") }).strict(),
      description: "Search the public web; returns source links and snippets, not verified full text, and does not generate an answer. Use it directly when you need to check a fact quickly.",
      run: async (call, args) => done(await ops.searchWeb(args as { query: string; objective: string }, call.signal)) },
    { name: "read_page", readOnly: true, schema: z.object({ url: text(1, 2000) }).strict(),
      description: "Read the body text (Markdown) of a public web page, with its original URL. Use it when the Expert wants the full text of an article or page; search results have only snippets. It cannot read pages behind a login and does not transcribe video.",
      run: async (call, args) => done(await ops.readPage(String(args.url), call.signal)) },
    { name: "list_agents", readOnly: true, schema: z.object({}).strict(),
      description: "All of the Expert's Agents: id, name, promise, status, price, opening questions, whether it is live and its pending changes (live), and the progress of the interview outline.",
      run: async call => done(await ops.agents(call.accountId)) },
    { name: "list_tasks", readOnly: true, schema: z.object({}).strict(),
      description: "Things not yet finished: those in progress, and those waiting for the Expert to answer or confirm, or stuck.",
      run: async call => done((await ops.openTasks(call.accountId)).map(taskView)) },
    { name: "create_agent", readOnly: false, schema: z.object({ name: text(1, 240), promise: text(1, 2000).describe("One sentence: who this Agent helps and what it solves for them") }).strict(),
      description: "Create a new draft Agent for the Expert. A draft is not public and needs no confirmation.",
      run: async (call, args) => done(await ops.createAgent(call.accountId, String(args.name), String(args.promise))) },
    { name: "propose_change", readOnly: false,
      schema: z.object({ agent_id: z.string(), release: z.enum(["publish", "withdraw"]).optional(), name: z.string().max(240).optional(), promise: z.string().max(2000).optional(), pricing: z.any().optional(), opening_questions: z.any().optional() }).strict(),
      description: "Change the name, promise, price or opening questions, or publish or unpublish the product (release). These are publicly visible, so the Expert is asked to confirm first and it takes effect only after confirmation. The pricing structure is the same as what list_agents returns.",
      run: async (call, args) => {
        const input = args as { agent_id: string; release?: "publish" | "withdraw"; name?: string; promise?: string; pricing?: unknown; opening_questions?: unknown };
        return done(await created(call, await ops.propose(call.accountId, input.agent_id, { release: input.release, name: input.name, promise: input.promise, pricing: input.pricing, briefSpec: input.opening_questions }, await call.origin())));
      } },
    { name: "start_task", readOnly: false,
      schema: z.object({ kind: z.enum(WORKER_KINDS), agent_id: z.string().optional().describe("Which Agent this is for: the Agent's id, or its name. Required for interview, build, evaluate and agent_research when the Expert has two or more Agents; may be omitted when there is only one"), instruction: text(1, 4000).describe("What to do, the Expert's own words, and why now") }).strict(),
      description: `Dispatch a piece of work; returns immediately and you are told when it is done. In the turn where you dispatch, do not write a preview or phrases like "I'm on it" or "next". interview only writes the interview outline and does not talk to the Expert; you are told when the outline is written, and then you ask the Expert yourself. build is accepted only once every item in this Agent's interview outline is ✓. When the Expert has two or more Agents, agent_id is required (id or name; see list_agents); with only one it may be omitted. ${WORKER_KINDS.map(kind => ops.describeWorker(kind)).join("; ")}.`,
      run: async (call, args) => {
        const input = args as { kind: WorkerKind; agent_id?: string; instruction: string };
        let agentId = input.agent_id;
        if (ops.needsAgent(input.kind)) {
          const agents = await ops.agents(call.accountId);
          const { agent, refusal } = targetAgent(agents, agentId);
          if (refusal) throw new Error(refusal);
          agentId = agent?.productId ?? agentId;
        }
        const task = await ops.dispatch(call.accountId, input.kind, agentId, input.instruction, await call.origin());
        return done(await created(call, task));
      } },
    { name: "tick_outline", readOnly: false,
      schema: z.object({ agent_id: z.string().optional().describe("The Agent's id or name; may be omitted when the Expert has only one Agent"), item: text(1, 160).describe("The title of this outline item (as written in list_agents; a fragment that matches it uniquely is enough)") }).strict(),
      description: "Tick off one item of the interview outline: an item counts as finished only when the Expert's own words already meet the \"When an item is done\" criterion in the prompt. If not met, do not tick it; keep asking. build can be dispatched only after the whole outline is ticked.",
      run: async (call, args) => done({ outline: await ops.tickOutline(call.accountId, await agentFor(ops, call.accountId, args.agent_id), String(args.item)) }) },
    { name: "add_to_agent", readOnly: false,
      schema: z.object({ agent_id: z.string().optional().describe("The Agent's id or name; may be omitted when the Expert has only one Agent"), files: z.array(z.string()).max(20).optional().describe("The path under which a file the Expert sent is shown in the conversation"), links: z.array(z.string()).max(20).optional().describe("Web page links to fetch"), context: text(1, 2000).optional().describe("What these materials are and why they were given") }).strict(),
      description: "A file or link the Expert sent: when, by common sense (file name and content), it clearly belongs to some Agent's materials, add it to that Agent's materials; if it was just sent for a casual look, leave it in the conversation and do nothing. Where it goes is automatic; you do not choose.",
      run: async (call, args) => {
        const input = args as { files?: string[]; links?: string[]; context?: string };
        if (!input.files?.length && !input.links?.length) throw new Error("Give at least one of files and links.");
        return done({ went: await ops.addToAgent(call.accountId, await agentFor(ops, call.accountId, args.agent_id), { files: input.files ?? [], links: input.links ?? [], context: input.context }) });
      } },
    { name: "exclude_source", readOnly: false, schema: z.object({ source: text(1, 500), reason: z.string().max(500).optional() }).strict(),
      description: "Call when the Expert says a source does not count. All later work will stop using it.",
      run: async (call, args) => { await ops.excludeSource(call.accountId, String(args.source), args.reason as string | undefined); return done("Noted"); } },
    { name: "answer_task", readOnly: false, schema: z.object({ task_id: z.string(), answer: text(1, 20000) }).strict(),
      description: "Hand the Expert's answer to something back to it, verbatim.",
      run: async (call, args) => done(taskView(await ops.answer(call.accountId, String(args.task_id), String(args.answer), `run:${call.runId}:answer:${args.task_id}`))) },
    { name: "approve_task", readOnly: false, schema: z.object({ task_id: z.string() }).strict(),
      description: "The Expert agreed in the conversation to something that needs confirmation.",
      run: async (call, args) => done(taskView(await ops.approve(call.accountId, String(args.task_id), `run:${call.runId}:approve:${args.task_id}`))) },
    { name: "decline_task", readOnly: false, schema: z.object({ task_id: z.string() }).strict(),
      description: "The Expert refused something that needs confirmation, or something stuck is no longer needed.",
      run: async (call, args) => done(taskView(await ops.decline(call.accountId, String(args.task_id), `run:${call.runId}:decline:${args.task_id}`))) },
    { name: "poke", readOnly: false, schema: z.object({ task_id: z.string(), question: text(1, 500) }).strict(),
      description: "During a daily check, decide to ask the Expert a question. Record the question, then give the question itself as your reply.",
      run: async (call, args) => done(taskView(await ops.poke(call.accountId, String(args.task_id), String(args.question)))) },
    { name: "finish_task", readOnly: false, schema: z.object({ task_id: z.string(), answered: z.boolean().optional().describe("The Expert answered the poke question") }).strict(),
      description: "Finish a piece of work: a daily check that decides not to ask today; the Expert answered a poke; or a result the Expert has already been told.",
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
