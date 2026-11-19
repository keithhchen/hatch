import assert from "node:assert/strict";
import test from "node:test";
import { accessCodeRedirect } from "../server.mjs";
import { BUYER_FIELDS, PendingIntake, formatPrice, invalidField, CodeRoute, accessCodePayUrl, inWeChat, intakeAnswers, missingField, stepStates, typedCode } from "./codePageModel.js";

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
