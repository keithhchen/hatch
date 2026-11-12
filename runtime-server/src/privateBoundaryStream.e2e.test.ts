import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentCorpusResolver } from "./agentCorpus.js";
import type { AuthIdentityResolver, EntitlementBinding, EntitlementResolver } from "./entitlements.js";
import { createRuntimeServer } from "./index.js";
import { RuntimeStore } from "./store.js";

const asset = (id: string, assetPath: string, content: string) => ({ id, path: assetPath, sha256: `sha256:${createHash("sha256").update(content).digest("hex")}` });

/** A real published Agent Corpus on disk: its root is the private path the Expert's IP lives under. */
async function writeCorpus(entitlement: EntitlementBinding): Promise<{ baseRoot: string; corpusRoot: string }> {
  const baseRoot = await mkdtemp(path.join(os.tmpdir(), "hatch-private-boundary-corpus-"));
  const corpusRoot = path.join(baseRoot, entitlement.creator_id, entitlement.agent_id);
  await mkdir(path.join(corpusRoot, "instructions"), { recursive: true });
  await mkdir(path.join(corpusRoot, "evals"), { recursive: true });
  await writeFile(path.join(corpusRoot, "instructions/system.md"), "Be useful.", "utf8");
  await writeFile(path.join(corpusRoot, "evals/evals.json"), "[]", "utf8");
  await writeFile(path.join(corpusRoot, "agent.json"), JSON.stringify({
    contract_version: "1",
    creator: { id: entitlement.creator_id, name: "Expert" },
    product: { id: entitlement.product_id, name: "Product" },
    instructions: { system: asset("system", "instructions/system.md", "Be useful.") },
    skills: [],
    tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }],
    evaluations: { synthetic_qa: [asset("synthetic", "evals/evals.json", "[]")], held_out: [asset("held-out", "evals/evals.json", "[]")] }
  }), "utf8");
  return { baseRoot, corpusRoot };
}

test("a buyer's HTTP event stream carries no private corpus path, as on the WebSocket", async () => {
  const entitlement: EntitlementBinding = {
    entitlement_id: "44444444-4444-4444-8444-444444444444", order_id: "55555555-5555-4555-8555-555555555555",
    user_id: "11111111-1111-4111-8111-111111111111", creator_id: "22222222-2222-4222-8222-222222222222",
    agent_id: "33333333-3333-4333-8333-333333333333", product_id: "33333333-3333-4333-8333-333333333333", status: "active"
  };
  const { baseRoot, corpusRoot } = await writeCorpus(entitlement);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-private-boundary-"));
  const entitlementResolver: EntitlementResolver = { list: async () => [entitlement], resolve: async () => entitlement };
  const authIdentityResolver: AuthIdentityResolver = { resolveIdentity: async () => ({ sub: entitlement.user_id }) };
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(dataDir), entitlementResolver, authIdentityResolver, agentCorpusResolver: new AgentCorpusResolver(baseRoot),
    createRuntime: () => ({ async *run(input) {
      yield { type: "tool_call.delta" as const, run_id: input.run_id, tool_call_id: "t1", name: "knowledge_read", locality: "server" as const, approval: "none" as const,
        status: "completed" as const, arguments: { path: `${corpusRoot}/skills/secret/SKILL.md` }, result: { text: "ok" } };
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } })
  });
  try {
    await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const address = runtime.server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    const query = new URLSearchParams({ entitlement_id: entitlement.entitlement_id, creator_id: entitlement.creator_id, product_id: entitlement.product_id }).toString();
    const headers = { authorization: "Bearer buyer-session", "content-type": "application/json" };
    const created = await (await fetch(`${base}/v1/conversations?${query}`, { method: "POST", headers, body: JSON.stringify({ client_request_id: "private_boundary" }) })).json() as { conversation: { id: string } };
    const stream = await fetch(`${base}/v1/conversations/${encodeURIComponent(created.conversation.id)}/messages?${query}`, {
      method: "POST", headers: { ...headers, accept: "text/event-stream" }, body: JSON.stringify({ client_message_id: "m-1", content: "read it" })
    });
    const text = await stream.text();
    assert.match(text, /tool_call\.delta/, "the tool call is streamed");
    assert.equal(text.includes(corpusRoot), false, "no private path in the buyer's stream");
  } finally {
    await runtime.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});
