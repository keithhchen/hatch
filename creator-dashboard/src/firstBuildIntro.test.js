import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dismissIntro, introDismissed, shouldShowFirstBuildIntro } from "./firstBuildIntro.js";

const memory = () => { const data = new Map(); return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }; };
const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
const facts = (over = {}) => ({ accountId: "acct-1", products: [], storage: memory(), ...over });
const read = (name) => readFile(new URL(name, import.meta.url), "utf8");

test("the intro shows for an account with no Agents", () => {
  assert.equal(shouldShowFirstBuildIntro(facts()), true);
});

test("the intro does not show once dismissed, for that account only", () => {
  const storage = memory();
  dismissIntro("acct-1", storage);
  assert.equal(introDismissed("acct-1", storage), true);
  assert.equal(shouldShowFirstBuildIntro(facts({ storage })), false);
  assert.equal(shouldShowFirstBuildIntro(facts({ storage, accountId: "acct-2" })), true);
});

test("the intro is not auto-shown when the account has Agents, or before the list has loaded", () => {
  assert.equal(shouldShowFirstBuildIntro(facts({ products: [{ product_id: "p1" }] })), false);
  assert.equal(shouldShowFirstBuildIntro(facts({ products: null })), false);
  assert.equal(shouldShowFirstBuildIntro(facts({ accountId: "" })), false);
});

test("unavailable browser storage never throws", () => {
  assert.equal(introDismissed("acct-1", broken), false);
  assert.doesNotThrow(() => dismissIntro("acct-1", broken));
});

test("the help button always opens the intro: on the New Agent page and in the Agent workspace, not in the Build tab body", async () => {
  const dialog = await read("./FirstBuildDialog.jsx");
  const workspace = await read("./studioAgentWorkspace.jsx");
  const create = await read("./CreatorSourceLibrary.jsx");
  const portal = await read("./CreatorPortalV2.jsx");
  assert.match(dialog, /aria-label=\{copy\.help\} onClick=\{\(\) => setOpen\(true\)\}><HelpCircle/);
  assert.match(dialog, /navigate\(creatorFactoryPath\(productId, "sources", "uploads"\)\)/);
  assert.match(dialog, /if \(!onNewPage\) navigate/);
  assert.match(dialog, /import \{ TrialScene \} from "\.\/web\/TrialScenes\.tsx"/);
  assert.equal(dialog.match(/<Button /g)?.length, 1);
  assert.match(create, /<FirstBuildIntro request=\{request\} profile=\{profile\}/);
  assert.match(portal, /<CreatorProductFiles request=\{request\} profile=\{profile\}/);
  assert.match(workspace, /<FirstBuildIntro request=\{request\} productId=\{productId\}/);
  assert.doesNotMatch(workspace, /tab === "build" \? <FirstBuildIntro/);
});

test("the landing dialog still renders its three scenes from the shared component", async () => {
  const page = await read("./web/HatchPage.tsx");
  const scenes = await read("./web/TrialScenes.tsx");
  const css = await read("./web/web.css");
  assert.match(page, /import \{ TrialScene \} from "\.\/TrialScenes"/);
  assert.match(page, /<TrialScene index=\{index\} m=\{a\.mini\} \/>/);
  assert.match(page, /a\.steps\.map/);
  assert.doesNotMatch(page, /function TrialScene/);
  assert.equal(scenes.match(/className="tm tm-/g)?.length, 3);
  assert.doesNotMatch(css, /\.tm-/);
});
