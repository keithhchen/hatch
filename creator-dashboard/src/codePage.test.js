import assert from "node:assert/strict";
import test from "node:test";
import { accessCodeRedirect, landingResponse } from "../server.mjs";
import { BUYER_FIELDS, PendingIntake, createStatusPoller, feedPool, feedWindow, siteDomain, visibleSteps, formatPrice, invalidField, CodeRoute, accessCodePayUrl, inWeChat, intakeAnswers, missingField, stepStates, typedCode, advance, hookCopy, reachableStep, stepFromHash, stepHash } from "./codePageModel.js";

const PRODUCT = "159c0f12-6e23-4512-af7b-928833d199d7";

test("the landing is /c/ and a code's page is /c/<code>; nothing else is theirs", () => {
  assert.deepEqual(CodeRoute.parse("/c"), { code: null });
  assert.deepEqual(CodeRoute.parse("/c/"), { code: null });
  assert.deepEqual(CodeRoute.parse("/c/MSC123456"), { code: "MSC123456" });
  assert.equal(CodeRoute.parse("/chat/product/x"), null);
  assert.equal(CodeRoute.parse("/c/MSC123456/more"), null);
  assert.equal(CodeRoute.codePath("MSC123456"), "/c/MSC123456");
});

test("the pay link names the Product and the email, and comes back to the landing", () => {
  const url = new URL(accessCodePayUrl({ productId: PRODUCT, email: " buyer+x@example.com ", origin: "https://gethatchapp.com" }));
  assert.equal(`${url.origin}${url.pathname}`, "https://anyteach.cn/hatch-pay/");
  assert.equal(url.searchParams.get("product"), PRODUCT);
  assert.equal(url.searchParams.get("email"), "buyer+x@example.com");
  assert.equal(url.searchParams.get("back"), "https://gethatchapp.com/c/");
  assert.match(url.search, /back=https%3A%2F%2Fgethatchapp\.com%2Fc%2F/);
});

test("WeChat's in-app browser is told by its user agent; phone browsers are not", () => {
  assert.equal(inWeChat("Mozilla/5.0 (iPhone) AppleWebKit MicroMessenger/8.0.40"), true);
  assert.equal(inWeChat("Mozilla/5.0 (iPhone) Version/17 Mobile Safari/604.1"), false);
  assert.equal(inWeChat("Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36"), false);
  assert.equal(inWeChat(undefined), false);
});

test("a typed code is trimmed and upper-cased, or it is not a code", () => {
  assert.equal(typedCode(" msc123456 "), "MSC123456");
  assert.equal(typedCode("ab"), undefined);
  assert.equal(typedCode("has space"), undefined);
});

test("steps are done before the one in progress, and nothing is in progress before the Run has done anything", () => {
  const steps = [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }];
  assert.deepEqual(stepStates(steps, 1).map(step => step.state), ["done", "now", "next"]);
  assert.deepEqual(stepStates(steps, -1).map(step => step.state), ["next", "next", "next"]);
  assert.deepEqual(stepStates(undefined, -1), []);
});

test("the intake asks only what is required, and sends trimmed answers", () => {
  const fields = [{ id: "website", label: "网址", required: true }, { id: "markets", label: "市场", required: false }];
  assert.equal(missingField(fields, { website: "  " })?.id, "website");
  assert.equal(missingField(fields, { website: "x.com" }), undefined);
  assert.deepEqual(intakeAnswers(fields, { website: " x.com " }), { website: "x.com", markets: "" });
});

test("back from paying, /c/?code= goes to that code's page: any case, trimmed; anything else is left to the page", () => {
  assert.equal(accessCodeRedirect("/c/", "msc123456"), "/c/MSC123456");
  assert.equal(accessCodeRedirect("/c", " MSC123456 "), "/c/MSC123456");
  assert.equal(accessCodeRedirect("/c/", null), null);
  assert.equal(accessCodeRedirect("/c/", "x"), null);
  assert.equal(accessCodeRedirect("/c/", "../../etc"), null);
  assert.equal(accessCodeRedirect("/c/MSC123456", "MSC123456"), null);
  assert.equal(accessCodeRedirect("/chat/product/x", "MSC123456"), null);
});

test("the pay link also carries the website and the name", () => {
  const url = new URL(accessCodePayUrl({ productId: PRODUCT, email: "a@b.co", origin: "https://gethatchapp.com", site: " https://x.com ", name: " 王 " }));
  assert.equal(url.searchParams.get("site"), "https://x.com");
  assert.equal(url.searchParams.get("name"), "王");
  assert.equal(url.searchParams.get("product"), PRODUCT);
});

test("the website is shown as a domain", () => {
  assert.equal(siteDomain("https://www.Example.com/path?q=1"), "example.com");
  assert.equal(siteDomain("example.com/a"), "example.com");
  assert.equal(siteDomain("  "), undefined);
});

test("the publish step is never shown", () => {
  const steps = [{ id: "fetch", label: "抓取网站" }, { id: "write", label: "撰写报告" }, { id: "publish", label: "发布" }];
  assert.deepEqual(visibleSteps(steps).map(step => step.id), ["fetch", "write"]);
  assert.deepEqual(visibleSteps([{ id: "x", label: "发布" }]), []);
});

test("the feed is static: the checks first, and scoring dimensions open only as steps advance", () => {
  const steps = [{}, {}, {}];
  assert.ok(feedPool({ steps, step: -1 })[0].startsWith("正在核对"));
  const count = step => feedPool({ steps, step }).filter(line => line.startsWith("正在评估")).length;
  assert.equal(count(-1), 0);
  assert.ok(count(0) > 0 && count(0) < count(2));
  assert.equal(count(2), 9);
  assert.deepEqual(feedWindow(["a", "b", "c", "d"], 3, 3), ["d", "a", "b"]);
  assert.deepEqual(feedWindow([], 5), []);
});

// A fake clock: scheduled ticks run when the test says so.
function clock() {
  const queue = [];
  const delays = [];
  return { delays, schedule: (fn, delay) => { delays.push(delay); queue.push(fn); return queue.length; }, cancel: () => {}, pending: () => queue.length, run: async () => { await queue.shift()?.(); } };
}

test("the poller keeps reading while generating, switches by itself when ready, and stops there", async () => {
  const time = clock();
  const answers = [{ state: "generating", step: 0 }, { state: "generating", step: 1 }, { state: "ready" }];
  const seen = [];
  const poller = createStatusPoller({ read: async () => answers.shift(), onStatus: status => seen.push(status.state + (status.step ?? "")), onError: () => {}, schedule: time.schedule, cancel: time.cancel });
  await poller.start();
  assert.equal(time.pending(), 1);
  await time.run();
  await time.run();
  assert.deepEqual(seen, ["generating0", "generating1", "ready"]);
  assert.equal(time.pending(), 0, "nothing is scheduled after ready");
});

test("a status accepted from outside (the intake's answer) starts the polling that the first read had ended", async () => {
  const time = clock();
  const seen = [];
  const poller = createStatusPoller({ read: async () => ({ state: "ready" }), onStatus: status => seen.push(status.state), onError: () => {}, schedule: time.schedule, cancel: time.cancel });
  poller.accept({ state: "intake" });
  assert.equal(time.pending(), 0);
  poller.accept({ state: "generating" });
  assert.equal(time.pending(), 1);
  await time.run();
  assert.deepEqual(seen, ["intake", "generating", "ready"]);
  assert.equal(time.pending(), 0);
});

test("a failed read is reported and tried again; a stopped poller does nothing more", async () => {
  const time = clock();
  const errors = [];
  let calls = 0;
  const poller = createStatusPoller({ read: async () => { calls++; if (calls === 1) throw new Error("net"); return { state: "generating" }; }, onStatus: () => {}, onError: error => errors.push(error.message), schedule: time.schedule, cancel: time.cancel });
  await poller.start();
  assert.deepEqual(errors, ["net"]);
  assert.equal(time.pending(), 1);
  poller.stop();
  await time.run();
  assert.equal(time.pending(), 0);
});

test("waits are 8 s with ±15% jitter, double on consecutive errors up to 60 s, and reset on success", async () => {
  const time = clock();
  const outcomes = ["err", "err", "err", "err", "err", "err", "ok", "ok"];
  const poller = createStatusPoller({ read: async () => { if (outcomes.shift() === "err") throw new Error("net"); return { state: "generating" }; }, onStatus: () => {}, onError: () => {}, random: () => 0.5, schedule: (fn, d) => time.schedule(fn, d), cancel: time.cancel });
  await poller.start();
  for (let i = 0; i < 7; i++) await time.run();
  assert.deepEqual(time.delays, [16000, 32000, 60000, 60000, 60000, 60000, 8000, 8000]);
  const bounds = r => { const t = clock(); createStatusPoller({ read: async () => ({ state: "generating" }), onStatus: () => {}, onError: () => {}, random: () => r, schedule: (fn, d) => t.schedule(fn, d), cancel: t.cancel }).start(); return t; };
  const low = bounds(0), high = bounds(1);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(low.delays[0], 6800);
  assert.equal(high.delays[0], 9200);
});

test("the price is fen shown as yuan with two decimals", () => {
  assert.equal(formatPrice(1), "¥0.01");
  assert.equal(formatPrice(990), "¥9.90");
});

test("the product form needs name, phone, email and website; markets is optional; email must look like one", () => {
  const full = { name: "A", phone: "1", email: "a@b.co", website: "x.com" };
  assert.equal(invalidField(full), undefined);
  assert.equal(invalidField({ ...full, phone: " " }), "请填写：电话");
  assert.equal(invalidField({ ...full, email: "nope" }), "邮箱格式不对");
  assert.equal(BUYER_FIELDS.find(field => field.id === "markets").required, false);
});

test("answers kept for the way back are read once and forgotten", () => {
  const data = new Map();
  const storage = { setItem: (key, value) => data.set(key, value), getItem: key => data.get(key) ?? null, removeItem: key => data.delete(key) };
  assert.equal(PendingIntake.take(storage), undefined);
  PendingIntake.save(storage, { name: " A ", email: "a@b.co", extra: "dropped" });
  assert.deepEqual(PendingIntake.take(storage), { name: "A", phone: "", email: "a@b.co", website: "", markets: "" });
  assert.equal(PendingIntake.take(storage), undefined);
});

const FILLED = { name: "A", phone: "1", email: "a@b.co", website: "example.com" };

test("the steps go hook, form, pay; the form only passes when valid", () => {
  assert.deepEqual(advance("hook", {}), { step: "form" });
  assert.deepEqual(advance("form", { ...FILLED, website: "" }), { step: "form", error: "请填写：网址" });
  assert.deepEqual(advance("form", { ...FILLED, email: "nope" }), { step: "form", error: "邮箱格式不对" });
  assert.deepEqual(advance("form", FILLED), { step: "pay" });
});

test("the address hash names the step; pay without valid answers is the form", () => {
  assert.equal(stepFromHash(""), "hook");
  assert.equal(stepFromHash("#form"), "form");
  assert.equal(stepFromHash("#pay"), "pay");
  assert.equal(stepFromHash("#other"), "hook");
  assert.equal(stepHash("hook"), "");
  assert.equal(stepHash("pay"), "#pay");
  assert.equal(reachableStep("pay", {}), "form");
  assert.equal(reachableStep("pay", FILLED), "pay");
  assert.equal(reachableStep("form", {}), "form");
});

test("the landing endpoint carries the Agent's words from landing.json, else the name and description", () => {
  const product = { name: "出海官网获客诊断", description: "诊断官网" };
  const full = landingResponse("p1", { product, creator: { name: "MSC咨询" }, price_fen: 990, landing: { agent_name: "诊断 Agent", hook: "你好", cta: "开始诊断" } });
  assert.deepEqual(full, { product_id: "p1", name: "出海官网获客诊断", description: "诊断官网", price_fen: 990, creator_name: "MSC咨询", agent_name: "诊断 Agent", hook: "你好", cta: "开始诊断" });
  const bare = landingResponse("p1", { product, creator: { name: "MSC咨询" }, price_fen: 990 });
  assert.equal(bare.agent_name, "出海官网获客诊断");
  assert.equal(bare.hook, "诊断官网");
  assert.equal("cta" in bare, false);
  assert.equal(hookCopy(bare).cta, "开始诊断");
});
