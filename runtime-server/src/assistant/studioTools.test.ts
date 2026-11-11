import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantTask } from "./tasks.js";
import { studioTools, type AgentOverview, type StudioOperations, type WorkerKind } from "./studioTools.js";

const agent = (productId: string, name: string, outline: AgentOverview["interview_outline"]): AgentOverview => ({ productId, name, promise: "p", status: "draft", live: null, interview_outline: outline });

/** Only what start_task touches: the Agents, and where dispatch lands. */
function startTask(agents: AgentOverview[]) {
  const dispatched: Array<{ kind: WorkerKind; productId?: string }> = [];
  const ops = {
    agents: async () => agents,
    needsAgent: (kind: WorkerKind) => kind !== "research",
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

test("research needs no Agent", async () => {
  const { dispatched, run } = startTask([agent("p1", "a", []), agent("p2", "b", [])]);
  await run({ kind: "research", instruction: "林婉清" });
  assert.deepEqual(dispatched, [{ kind: "research", productId: undefined }]);
});

test("build refuses until the interview outline is all done", async () => {
  const open = [{ title: "案例", status: "completed" as const }, { title: "例外", status: "pending" as const }];
  const { dispatched, run } = startTask([agent("p1", "文书顾问", open), agent("p2", "没访谈过", [])]);
  await assert.rejects(run({ kind: "build", agent_id: "p1", instruction: "构建" }), /还有没聊完的：例外/);
  await assert.rejects(run({ kind: "build", agent_id: "p2", instruction: "构建" }), /还没有访谈大纲/);
  await run({ kind: "interview", agent_id: "p1", instruction: "接着聊" });
  assert.deepEqual(dispatched, [{ kind: "interview", productId: "p1" }], "interview is never gated");
});

test("with two Agents, agent_id may be the Agent's name, and an unknown one lists the choices", async () => {
  const { dispatched, run } = startTask([agent("p1", "美本顾问", done), agent("p2", "UCAS 顾问", done)]);
  await run({ kind: "build", agent_id: "UCAS 顾问", instruction: "构建" });
  await run({ kind: "build", agent_id: "p1", instruction: "构建" });
  assert.deepEqual(dispatched, [{ kind: "build", productId: "p2" }, { kind: "build", productId: "p1" }]);
  await assert.rejects(run({ kind: "build", agent_id: "不存在", instruction: "构建" }), /没有这个 Agent：不存在.*「UCAS 顾问」 → p2.*agent_id/);
});
