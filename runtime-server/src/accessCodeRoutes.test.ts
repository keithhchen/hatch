import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { ACCESS_CODE_CAPABILITY, AccessGate, type AccessCodes, type RedeemResult } from "./accessGate.js";
import { InMemoryProductCapabilities } from "./agentBox/capabilities.js";
import type { AgentCorpus, AgentCorpusResolver } from "./agentCorpus.js";
import { createRuntimeServer, type RuntimeServer } from "./index.js";
import { RuntimeStore } from "./store.js";

const PRODUCT = "33333333-3333-4333-8333-333333333333";
const briefSpec = {
  contract_version: "1" as const,
  fields: [
    { id: "email", label: "邮箱", required: true, type: "email" as const },
    { id: "code", label: "兑换码", required: true, type: "access_code" as const },
    { id: "website", label: "网址", required: true, type: "line" as const }
  ]
};

/** Test-only AccessCodes: the Postgres adapter lives on feat/wxpay-access-codes. */
class MemoryAccessCodes implements AccessCodes {
  rows: Record<string, { status: "pending" | "active" | "used" | "void"; productId: string; conversationId: string | null }> = {
    ONE: { status: "active", productId: PRODUCT, conversationId: null },
    TWO: { status: "active", productId: PRODUCT, conversationId: null },
    UNPAID: { status: "pending", productId: PRODUCT, conversationId: null }
  };
  async redeem({ code, productId, conversationId }: { code: string; productId: string; conversationId: string }): Promise<RedeemResult> {
    const row = this.rows[code];
    if (!row) return { ok: false, reason: "not_found" };
    if (row.productId !== productId) return { ok: false, reason: "wrong_product" };
    if (row.status === "pending" || row.status === "void") return { ok: false, reason: "not_paid" };
    if (row.status === "used") return row.conversationId === conversationId ? { ok: true } : { ok: false, reason: "used" };
    row.status = "used"; row.conversationId = conversationId;
    return { ok: true };
  }
  async lookup(code: string) { return this.rows[code] ?? null; }
}

let runtime: RuntimeServer | undefined;
afterEach(async () => { await runtime?.close(); runtime = undefined; });

async function start(codes: MemoryAccessCodes, capable = true) {
  const corpus = async () => ({
    root: "", digest: `sha256:${"b".repeat(64)}`,
    corpus: {
      agent_id: PRODUCT, creator: { id: "22222222-2222-4222-8222-222222222222", name: "Expert" },
      product: { id: PRODUCT, name: "Audit", boundaries: [], brief_spec: briefSpec, presentation: {} }, knowledge: { documents: [] }, tools: []
    } as unknown as AgentCorpus
  });
  runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-access-code-"))),
    // The browser's own token is its identity: guest-a is guest-a.
    authIdentityResolver: { resolveIdentity: async (token) => token ? { sub: `guest:${token}` } : undefined },
    agentCorpusResolver: { resolve: corpus, resolveByProduct: corpus } as unknown as AgentCorpusResolver,
    accessGate: new AccessGate(new InMemoryProductCapabilities(capable ? [[PRODUCT, ACCESS_CODE_CAPABILITY]] : []), codes)
  });
  await new Promise<void>((resolve) => (runtime!.server as http.Server).listen(0, "127.0.0.1", () => resolve()));
  const address = (runtime.server as http.Server).address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (token: string, pathname: string, body?: Record<string, unknown>) => {
    const response = await fetch(`${base}/v1/conversations${pathname}${pathname.includes("?") ? "&" : "?"}product_id=${PRODUCT}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() as any };
  };
  const create = (token: string, code: string, key: string) => call(token, "", {
    client_request_id: key,
    brief_answers: [{ field_id: "email", value: "a@b.co" }, { field_id: "code", value: code }, { field_id: "website", value: "example.com" }]
  });
  return { call, create };
}

test("a refused code creates nothing and says why, in Chinese", async () => {
  const { call, create } = await start(new MemoryAccessCodes());
  for (const [code, message] of [["NOPE", "兑换码不存在"], ["UNPAID", "尚未支付"]] as const) {
    const refused = await create("guest-a", code, `k-${code}`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.message, message);
  }
  assert.deepEqual((await call("guest-a", "")).body.conversations, []);
});

test("a good code starts the conversation once: the same request again is the same conversation and spends nothing more", async () => {
  const codes = new MemoryAccessCodes();
  const { create } = await start(codes);
  const first = await create("guest-a", "ONE", "k1");
  const again = await create("guest-a", "ONE", "k1");
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.body.conversation.id, first.body.conversation.id);
  assert.equal(codes.rows.ONE!.status, "used");
});

test("every access to a Product with an access code needs the code of that conversation", async () => {
  const { call, create } = await start(new MemoryAccessCodes());
  const one = (await create("guest-a", "ONE", "k1")).body.conversation.id as string;
  const two = (await create("guest-b", "TWO", "k2")).body.conversation.id as string;

  // Without the code, not even its own browser reads or lists it.
  assert.equal((await call("guest-a", `/${one}/snapshot?view=page`)).status, 403);
  assert.deepEqual((await call("guest-a", "")).body.conversations, []);
  // The used code opens its conversation from any browser, listing and reading it.
  const listed = await call("hatch_code.ONE~somebody-else", "");
  assert.deepEqual(listed.body.conversations.map((c: { id: string }) => c.id), [one]);
  assert.equal((await call("hatch_code.ONE~somebody-else", `/${one}/snapshot?view=page`)).status, 200);
  // A wrong code, and the code of a different conversation, open nothing.
  assert.equal((await call("hatch_code.WRONG~guest-a", `/${one}/snapshot?view=page`)).status, 403);
  assert.equal((await call("hatch_code.TWO~guest-a", `/${one}/snapshot?view=page`)).status, 403);
  assert.equal((await call("hatch_code.ONE~guest-b", `/${two}/snapshot?view=page`)).status, 403);
});

test("a used code typed into the Brief opens the conversation it was used for", async () => {
  const { create } = await start(new MemoryAccessCodes());
  const first = await create("guest-a", "ONE", "k1");
  const elsewhere = await create("guest-z", "ONE", "k-new-device");
  assert.equal(elsewhere.status, 200);
  assert.equal(elsewhere.body.created, false);
  assert.equal(elsewhere.body.conversation.id, first.body.conversation.id);
});

test("a Product without the access_code capability is untouched", async () => {
  const { call } = await start(new MemoryAccessCodes(), false);
  const created = await call("guest-a", "", { client_request_id: "k", brief_answers: [{ field_id: "email", value: "a@b.co" }, { field_id: "code", value: "x" }, { field_id: "website", value: "w" }] });
  assert.equal(created.status, 201);
  assert.equal((await call("guest-a", `/${created.body.conversation.id}/snapshot?view=page`)).status, 200);
});
