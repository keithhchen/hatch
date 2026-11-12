import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryConversationRepository } from "./conversationRepository.js";
import { createRuntimeServer } from "./index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const scope = `creator_id=c1&user_id=u1&product_id=p1&corpus_digest=${DIGEST}`;

async function listConversations(insecureLocalMode?: boolean) {
  const runtime = createRuntimeServer({
    conversationRepository: new InMemoryConversationRepository(),
    ...(insecureLocalMode ? { insecureLocalMode } : {})
  });
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/conversations?${scope}`);
    return { status: response.status, body: await response.text() };
  } finally {
    await runtime.close();
  }
}

test("Runtime without resolvers and without the local-mode flag refuses to serve", async () => {
  const { status, body } = await listConversations();
  assert.notEqual(status, 200);
  assert.match(body, /no entitlement or Agent Corpus resolver/);
});

test("Runtime without resolvers serves local ids only with explicit insecureLocalMode", async () => {
  const { status } = await listConversations(true);
  assert.equal(status, 200);
});
