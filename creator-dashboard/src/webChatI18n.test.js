import test from "node:test";
import assert from "node:assert/strict";
import { webChatCopy, webChatErrorText, webChatT } from "./webChatI18n.js";

test("Web Chat provides complete English, Chinese, and Japanese copy", () => {
  const keys = Object.keys(webChatCopy.en).sort();
  assert.deepEqual(Object.keys(webChatCopy.zh).sort(), keys);
  assert.deepEqual(Object.keys(webChatCopy.ja).sort(), keys);
});

test("Web Chat translates interpolated copy and known client errors", () => {
  assert.equal(webChatT("en", "agentGenerating", { agent: "Tutor" }), "Tutor is generating a reply");
  assert.equal(webChatT("ja", "removeImage", { name: "plan.png" }), "plan.pngを削除");
  assert.equal(webChatT("en", "subscribeToExpertProduct", { name: "Maya" }), "Subscribe to Maya's product");
  assert.equal(webChatT("zh", "subscribeToExpertProduct", { name: "Maya" }), "订阅 Maya 的产品");
  assert.equal(webChatT("ja", "subscribeToExpertProduct", { name: "Maya" }), "Mayaの製品を購読する");
  assert.equal(webChatErrorText({ code: "web_local_tool_unavailable" }, "en"), "This browser cannot run local tools.");
  assert.equal(webChatErrorText({ code: "imageCountLimit" }, "zh"), "每条消息最多添加 8 张图片。");
});

test("Web Chat preserves server-owned error messages", () => {
  assert.equal(webChatErrorText({ message: "Runtime supplied detail" }, "ja"), "Runtime supplied detail");
});
