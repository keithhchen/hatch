import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dismissIntro, introDismissed, shouldShowFirstBuildIntro } from "./firstBuildIntro.js";

const memory = () => { const data = new Map(); return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }; };
const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
const facts = (over = {}) => ({ accountId: "acct-1", productId: "p1", products: [{ product_id: "p1" }], manualFiles: [], agents: [{ role: "voice" }], storage: memory(), ...over });

test("the dialog shows for a first Agent with no material", () => {
  assert.equal(shouldShowFirstBuildIntro(facts()), true);
});

test("the dialog does not show once dismissed, for that account only", () => {
  const storage = memory();
  dismissIntro("acct-1", storage);
  assert.equal(introDismissed("acct-1", storage), true);
  assert.equal(shouldShowFirstBuildIntro(facts({ storage })), false);
  assert.equal(shouldShowFirstBuildIntro(facts({ storage, accountId: "acct-2" })), true);
});

test("the dialog does not show for a second Agent", () => {
  assert.equal(shouldShowFirstBuildIntro(facts({ products: [{ product_id: "p1" }, { product_id: "p2" }] })), false);
  assert.equal(shouldShowFirstBuildIntro(facts({ products: [{ product_id: "p2" }] })), false);
});

test("the dialog does not show once there are uploads or an interview, or before the data has loaded", () => {
  assert.equal(shouldShowFirstBuildIntro(facts({ manualFiles: [{ path: "input/manual/a.md" }] })), false);
  assert.equal(shouldShowFirstBuildIntro(facts({ agents: [{ role: "voice", outputUpdatedAt: "2026-11-12T00:00:00.000Z" }] })), false);
  assert.equal(shouldShowFirstBuildIntro(facts({ products: null })), false);
  assert.equal(shouldShowFirstBuildIntro(facts({ manualFiles: null })), false);
  assert.equal(shouldShowFirstBuildIntro(facts({ accountId: "" })), false);
});

test("unavailable browser storage never throws", () => {
  assert.equal(introDismissed("acct-1", broken), false);
  assert.doesNotThrow(() => dismissIntro("acct-1", broken));
});

test("the dialog is mounted on the Build tab and one button starts the Upload step", async () => {
  const workspace = await readFile(new URL("./studioAgentWorkspace.jsx", import.meta.url), "utf8");
  const dialog = await readFile(new URL("./FirstBuildDialog.jsx", import.meta.url), "utf8");
  assert.match(workspace, /tab === "build" \? <FirstBuildIntro /);
  assert.match(dialog, /navigate\(creatorFactoryPath\(productId, "sources", "uploads"\)\)/);
  assert.match(dialog, /import \{ TrialScene \} from "\.\/web\/TrialScenes\.tsx"/);
  assert.equal(dialog.match(/<Button /g)?.length, 1);
});

test("the landing dialog still renders its three scenes from the shared component", async () => {
  const page = await readFile(new URL("./web/HatchPage.tsx", import.meta.url), "utf8");
  const scenes = await readFile(new URL("./web/TrialScenes.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("./web/web.css", import.meta.url), "utf8");
  assert.match(page, /import \{ TrialScene \} from "\.\/TrialScenes"/);
  assert.match(page, /<TrialScene index=\{index\} m=\{a\.mini\} \/>/);
  assert.match(page, /a\.steps\.map/);
  assert.doesNotMatch(page, /function TrialScene/);
  assert.equal(scenes.match(/className="tm tm-/g)?.length, 3);
  assert.doesNotMatch(css, /\.tm-/);
});
