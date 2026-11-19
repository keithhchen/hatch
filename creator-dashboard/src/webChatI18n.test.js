import test from "node:test";
import assert from "node:assert/strict";
import { conversationTitle, webChatCopy, webChatErrorText, webChatT } from "./webChatI18n.js";

test("Web Chat provides complete English, Chinese, and Japanese copy", () => {
  const keys = Object.keys(webChatCopy.en).sort();
  assert.deepEqual(Object.keys(webChatCopy.zh).sort(), keys);
  assert.deepEqual(Object.keys(webChatCopy.ja).sort(), keys);
});

test("Web Chat translates interpolated copy and known client errors", () => {
  assert.equal(webChatT("en", "agentGenerating", { agent: "Tutor" }), "Tutor is generating a reply");
  assert.equal(webChatT("ja", "removeImage", { name: "plan.png" }), "plan.pngを削除");
  assert.equal(webChatErrorText({ code: "web_local_tool_unavailable" }, "en"), "This browser cannot run local tools.");
  assert.equal(webChatErrorText({ code: "imageCountLimit" }, "zh"), "每条消息最多添加 8 张图片。");
  assert.equal(webChatT("ja", "expertAi", { name: "Maya" }), "Maya");
  assert.equal(webChatErrorText({ code: "agent_unavailable", message: "The published Agent could not be found." }, "en"), "This AI is currently unavailable. It may not be published yet, or it may be paused.");
});

test("a spent monthly usage limit is a real state in every language, not the server's English", () => {
  const error = { code: "usage_cap_exceeded", status: 429, message: "Monthly token limit reached. It resets on 2026-12-01." };
  assert.match(webChatErrorText(error, "en"), /monthly usage limit/);
  assert.match(webChatErrorText(error, "zh"), /使用额度/);
  assert.match(webChatErrorText(error, "ja"), /利用上限/);
});

test("Web Chat UI copy stays neutral: no exclamations, questions, or chatty phrasing", () => {
  for (const [locale, copy] of Object.entries(webChatCopy)) {
    for (const [key, text] of Object.entries(copy)) assert.doesNotMatch(text, /[!！?？]|聊|話して|chat with/i, `${locale}.${key}`);
  }
});

test("Web Chat preserves server-owned error messages", () => {
  assert.equal(webChatErrorText({ message: "Runtime supplied detail" }, "ja"), "Runtime supplied detail");
});

test("a refused message that needs an account reads as the login wall in every language, whatever the server said", () => {
  const error = { code: "login_required", status: 401, message: "Sign in to keep going." };
  assert.equal(webChatErrorText(error, "en"), "Sign in to continue the conversation.");
  assert.match(webChatErrorText(error, "zh"), /登录/);
  assert.match(webChatErrorText(error, "ja"), /ログイン/);
});

test("the retired purchase model has no Web Chat copy left", () => {
  for (const copy of Object.values(webChatCopy)) {
    for (const key of Object.keys(copy)) assert.doesNotMatch(key, /paywall|noAccess|subscribe|checkingSubscription/i, key);
  }
});

test("the sidebar shows a conversation's title, and the localized new-conversation name only while it has none", () => {
  const label = (locale, conversation) => conversationTitle(conversation, (key, values) => webChatT(locale, key, values));
  assert.equal(label("zh", { id: "c1", title: "juduvalve.com 获客诊断" }), "juduvalve.com 获客诊断");
  assert.equal(label("zh", { id: "c1" }), "新对话");
  assert.equal(label("en", { id: "c1", title: null }), "New conversation");
  assert.equal(label("ja", { id: "c1", title: "  " }), "新しい会話");
  assert.equal(label("en", { id: "c1", title: "Pricing review" }), "Pricing review");
});

test("the sidebar renders its titles through that helper", async () => {
  const { readFile } = await import("node:fs/promises");
  const shell = await readFile(new URL("./WebChatShell.jsx", import.meta.url), "utf8");
  assert.match(shell, /conversationTitle\(item, t\)/);
  assert.doesNotMatch(shell, /item\.title \|\|/);
});
