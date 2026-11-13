import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantTask } from "./tasks.js";
import type { WebScrapeProvider } from "../factoryAgents/webTypes.js";
import { PAGE_TEXT_LIMIT, readPage, studioTools, type AgentOverview, type StudioOperations, type WorkerKind } from "./studioTools.js";

const agent = (productId: string, name: string, outline: AgentOverview["interview_outline"]): AgentOverview => ({ productId, name, promise: "p", status: "draft", live: null, interview_outline: outline });

/** Only what start_task touches: the Agents, and where dispatch lands. */
function startTask(agents: AgentOverview[]) {
  const dispatched: Array<{ kind: WorkerKind; productId?: string }> = [];
  const ops = {
    agents: async () => agents,
    needsAgent: (_kind: WorkerKind) => true,
    describeWorker: (kind: WorkerKind) => kind,
    dispatch: async (_account: string, kind: WorkerKind, productId?: string) => { dispatched.push({ kind, productId }); return { id: "t1", kind, status: "working", payload: {}, productId } as unknown as AssistantTask; },
    inRun: async (task: AssistantTask) => task,
  } as unknown as StudioOperations;
  const tool = studioTools(ops).find(candidate => candidate.name === "start_task")!;
  return { dispatched, run: (args: Record<string, unknown>) => tool.run({ accountId: "a", runId: "r", origin: async () => ({ source: "web" }) }, tool.schema.parse(args)) };
}

const done = [{ title: "案例", status: "completed" as const }];

test("start_task defaults to the only Agent", async () => {
  const { dispatched, run } = startTask([agent("p1", "文书顾问", done)]);
  await run({ kind: "build", instruction: "构建" });
  assert.deepEqual(dispatched, [{ kind: "build", productId: "p1" }]);
});

test("start_task without agent_id lists the Agents when there are several", async () => {
  const { dispatched, run } = startTask([agent("p1", "美本顾问", done), agent("p2", "UCAS 顾问", done)]);
  await assert.rejects(run({ kind: "interview", instruction: "聊" }), /要指定 Agent.*「美本顾问」 → p1.*「UCAS 顾问」 → p2.*agent_id/);
  assert.deepEqual(dispatched, []);
});

test("with two Agents, agent_id may be the Agent's name, and an unknown one lists the choices", async () => {
  const { dispatched, run } = startTask([agent("p1", "美本顾问", done), agent("p2", "UCAS 顾问", done)]);
  await run({ kind: "build", agent_id: "UCAS 顾问", instruction: "构建" });
  await run({ kind: "build", agent_id: "p1", instruction: "构建" });
  assert.deepEqual(dispatched, [{ kind: "build", productId: "p2" }, { kind: "build", productId: "p1" }]);
  await assert.rejects(run({ kind: "build", agent_id: "不存在", instruction: "构建" }), /没有这个 Agent：不存在.*「UCAS 顾问」 → p2.*agent_id/);
});

test("the Assistant has read_page, and it reads through the ops", async () => {
  const urls: string[] = [];
  const ops = { describeWorker: (kind: WorkerKind) => kind, readPage: async (url: string) => { urls.push(url); return { url, text: "全文" }; } } as unknown as StudioOperations;
  const tool = studioTools(ops).find(candidate => candidate.name === "read_page")!;
  assert.ok(tool?.readOnly);
  assert.deepEqual(await tool.run({ accountId: "a", runId: "r", origin: async () => ({ source: "web" }) }, tool.schema.parse({ url: "https://example.com/a" })), { output: JSON.stringify({ url: "https://example.com/a", text: "全文" }) });
  assert.deepEqual(urls, ["https://example.com/a"]);
});

test("readPage asks the scrape port for Markdown and cuts what is too long", async () => {
  const asked: unknown[] = [];
  const port: WebScrapeProvider = { scrape: async request => { asked.push(request); return { provider: "fake", url: "https://example.com/final", retrievedAt: "t", title: "T", content: "x".repeat(PAGE_TEXT_LIMIT + 5) }; } };
  const page = await readPage(port, "https://example.com/a");
  assert.deepEqual(asked, [{ url: "https://example.com/a", extractDepth: "advanced", format: "markdown" }]);
  assert.equal(page.url, "https://example.com/final");
  assert.equal(page.text.length, PAGE_TEXT_LIMIT);
  assert.deepEqual([page.truncated, page.total_chars], [true, PAGE_TEXT_LIMIT + 5]);
});
