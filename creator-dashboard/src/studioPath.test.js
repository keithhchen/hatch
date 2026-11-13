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

test("Overview is a top tab, Advanced sits under the rail steps, Start Agent and todos use the product style", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (name) => readFile(new URL(name, import.meta.url), "utf8");
  const [workspace, factory, css, web] = await Promise.all([read("./studioAgentWorkspace.jsx"), read("./FactoryAgents.jsx"), read("./factoryAgents.css"), read("./web/web.css")]);
  assert.match(workspace, /\{ value: "overview", label: "sxNavOverview" \},\s*\{ value: "build"[^}]*\},\s*\{ value: "publish"/);
  assert.doesNotMatch(factory, /factory-rail__overview|factory-stepper__advanced/);
  assert.match(factory, /className=\{`factory-advanced/);
  assert.match(factory, /<HatchButton type="button" size="small" variant="secondary" leading=\{<Play/);
  assert.doesNotMatch(factory, /line-through/);
  assert.doesNotMatch(web, /pro-tasks[^\n]*line-through/);
  assert.match(factory.match(/<nav className="factory-rail"[^]*?<\/nav>/)[0], /factory-advanced/);
  assert.match(css, /grid-template-columns: max-content minmax\(0, 1fr\)/);
});

test("Agent header has one Product links dropdown: copy, open page, open chat; en/zh/ja", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./studioAgentWorkspace.jsx", import.meta.url), "utf8");
  const copy = await readFile(new URL("./studioShellCopy.js", import.meta.url), "utf8");
  assert.match(source, /return href \? <div className="sx-agent__actions">[^]*<DropdownMenu[^]*sxCopyProductLink[^]*sxOpenProductPage[^]*sxTryProductChat/);
  assert.match(source, /WebChatRoute\.productPath/);
  assert.match(source, /copyLink\(chatPathOf\(product\)\)/);
  assert.match(source, /copy\(url\)\.catch\(\(\) => setFailed\(true\)\)/);
  assert.doesNotMatch(source, /sxOpenPublic|sxTryChat|variant="secondary" leading=\{<Copy/);
  for (const key of ["sxProductLinks", "sxCopyProductLink", "sxOpenProductPage", "sxTryProductChat", "sxCopyChatLink"]) assert.equal(copy.match(new RegExp(`${key}: "`, "g")).length, 3);
  assert.match(copy, /sxProductLinks: "查看产品链接"/);
  assert.match(copy, /sxProductLinks: "プロダクトのリンク"/);
});

test("Advanced pill matches step pill type and shows the same selected state with aria-current=page", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("./factoryAgents.css", import.meta.url), "utf8");
  const factory = await readFile(new URL("./FactoryAgents.jsx", import.meta.url), "utf8");
  const rule = (selector) => css.match(new RegExp(`^${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`, "m"))[1];
  assert.match(rule(".factory-advanced"), /font-size: 14px; font-weight: 650/);
  assert.equal(rule(".factory-advanced.is-current"), rule(".factory-stepper .is-current"));
  assert.match(factory, /factory-advanced\$\{currentStep === ADVANCED_STEP\.id \? " is-current" : ""\}`\} aria-current=\{currentStep === ADVANCED_STEP\.id \? "page"/);
});
