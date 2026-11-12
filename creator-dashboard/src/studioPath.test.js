import assert from "node:assert/strict";
import test from "node:test";
import { ADVANCED_STEP, STUDIO_PATH, studioNextStep, studioPathStates, studioStepForRoute } from "./studioPath.js";

const agent = (role, state) => ({ role, state });
const file = { path: "input/manual/a.md" };

test("Studio path is upload, interview, build and publish; the advanced Agents are a separate tab", () => {
  assert.deepEqual(STUDIO_PATH.map((step) => step.id), ["upload", "ask", "build", "ship"]);
  assert.deepEqual(ADVANCED_STEP.items.map(([, role]) => role), ["research", "case-generation", "evaluator"]);
  assert.equal(STUDIO_PATH.some((step) => step.items.some(([, role]) => ADVANCED_STEP.items.some(([, advanced]) => advanced === role))), false);
});

test("Studio path derives step state only from the live Factory snapshot", () => {
  const states = studioPathStates([agent("voice", "running"), agent("generation", "locked")], { status: "working" }, [file]);
  assert.deepEqual(states.map((item) => item.state), ["done", "running", "locked", "todo"]);
  assert.equal(studioNextStep(states).step.id, "ask");
});

test("Advanced Agents never change the path's progress", () => {
  const states = studioPathStates([agent("research", "complete"), agent("evaluator", "complete"), agent("generation", "locked")], null, []);
  assert.deepEqual(states.map((item) => item.state), ["todo", "todo", "locked", "todo"]);
});

test("Studio path marks the client step done only for a live Product", () => {
  const states = studioPathStates([], { status: "published" });
  assert.equal(states.at(-1).state, "done");
  assert.equal(states[0].state, "todo");
});

test("Factory routes map onto the guided steps and the advanced tab", () => {
  assert.equal(studioStepForRoute("sources", "uploads"), "upload");
  assert.equal(studioStepForRoute("sources", "voice"), "ask");
  assert.equal(studioStepForRoute("build", "generation"), "build");
  for (const [section, page] of ADVANCED_STEP.items) assert.equal(studioStepForRoute(section, page), "advanced");
  assert.equal(studioStepForRoute(null, null), null);
});

test("Overview is a top tab, Advanced is a separate rail control, Start Agent and todos use the product style", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (name) => readFile(new URL(name, import.meta.url), "utf8");
  const [workspace, factory, css, web] = await Promise.all([read("./studioAgentWorkspace.jsx"), read("./FactoryAgents.jsx"), read("./factoryAgents.css"), read("./web/web.css")]);
  assert.match(workspace, /\{ value: "overview", label: "sxNavOverview" \},\s*\{ value: "build"[^}]*\},\s*\{ value: "publish"/);
  assert.doesNotMatch(factory, /factory-rail__overview|factory-stepper__advanced/);
  assert.match(factory, /className=\{`factory-advanced/);
  assert.match(factory, /<HatchButton type="button" size="small" variant="secondary" leading=\{<Play/);
  assert.doesNotMatch(factory, /line-through/);
  assert.doesNotMatch(web, /pro-tasks[^\n]*line-through/);
  assert.match(css, /\.factory-advanced \{[^}]*justify-self: end/);
  assert.doesNotMatch(factory.match(/<nav className="factory-rail"[^]*?<\/nav>/)[0], /factory-advanced/);
});

test("Publish header offers Try the chat beside View page, same live condition, in en/zh/ja", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./studioAgentWorkspace.jsx", import.meta.url), "utf8");
  const copy = await readFile(new URL("./studioShellCopy.js", import.meta.url), "utf8");
  assert.match(source, /return href \? <div className="sx-agent__actions">[^]*sxOpenPublic[^]*sxTryChat/);
  assert.match(source, /WebChatRoute\.productPath/);
  assert.equal(copy.match(/sxTryChat: "(Try the chat|体验产品聊天|チャットを試す)"/g).length, 3);
});
