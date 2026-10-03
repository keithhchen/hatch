import assert from "node:assert/strict";
import test from "node:test";
import { WebChatRoute } from "./webChatRoute.js";

test("Web Chat routes identify a product entry and an opaque conversation public ID", () => {
  assert.deepEqual(WebChatRoute.parse("/chat/product/802f2105-e28e-4ddc-996a-0a97a7fa4bb5"), {
    productId: "802f2105-e28e-4ddc-996a-0a97a7fa4bb5",
    conversationId: null
  });
  assert.deepEqual(WebChatRoute.parse("/chat/product/802f2105-e28e-4ddc-996a-0a97a7fa4bb5/conversation/conv_972f1b52d9ef4c1c93935e4be5fa7f01"), {
    productId: "802f2105-e28e-4ddc-996a-0a97a7fa4bb5",
    conversationId: "conv_972f1b52d9ef4c1c93935e4be5fa7f01"
  });
});

test("Web Chat route builders encode each resource identity", () => {
  assert.equal(
    WebChatRoute.conversationPath("product id", "conversation/id"),
    "/chat/product/product%20id/conversation/conversation%2Fid"
  );
});

test("Web Chat routes reject unrelated and incomplete paths", () => {
  assert.equal(WebChatRoute.parse("/chat/product/not-a-uuid"), null);
  assert.equal(WebChatRoute.parse("/chat/product/802f2105-e28e-4ddc-996a-0a97a7fa4bb5/conversation"), null);
});
