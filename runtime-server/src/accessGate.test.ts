import assert from "node:assert/strict";
import { test } from "node:test";
import { AccessCodeIdentityResolver } from "./accessCodeIdentity.js";
import { ACCESS_CODE_CAPABILITY, AccessGate, type AccessCodes, type RedeemResult } from "./accessGate.js";
import { InMemoryProductCapabilities } from "./agentBox/capabilities.js";
import { briefAccessCode, createBriefSnapshot } from "./brief.js";
import { ChatError } from "./chat/principal.js";

const PRODUCT = "159c0f12-6e23-4512-af7b-928833d199d7";
const spec = {
  contract_version: "1",
  fields: [
    { id: "email", label: "邮箱", required: true, type: "email" },
    { id: "code", label: "兑换码", required: true, type: "access_code" },
    { id: "website", label: "网址", required: true, type: "line" }
  ]
} as const;
const brief = (code: string) => createBriefSnapshot(spec, [{ field_id: "email", value: "a@b.co" }, { field_id: "code", value: code }, { field_id: "website", value: "example.com" }]);

/** Test-only AccessCodes: the Postgres adapter lives on feat/wxpay-access-codes. */
class MemoryAccessCodes implements AccessCodes {
  redeemed = 0;
  constructor(readonly rows: Record<string, { status: "pending" | "active" | "used" | "void"; productId: string; conversationId: string | null }>) {}
  async redeem({ code, productId, conversationId }: { code: string; productId: string; conversationId: string }): Promise<RedeemResult> {
    this.redeemed++;
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

const gateOver = (codes?: AccessCodes, capable = true) => new AccessGate(new InMemoryProductCapabilities(capable ? [[PRODUCT, ACCESS_CODE_CAPABILITY]] : []), codes);
const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as ChatError);

test("the Brief's access_code field is its code", () => {
  assert.equal(briefAccessCode(brief(" ABCD ")), "ABCD");
});

test("an active code is spent for the conversation and the Run may start", async () => {
  const codes = new MemoryAccessCodes({ GOOD: { status: "active", productId: PRODUCT, conversationId: null } });
  await gateOver(codes).admit(PRODUCT, "c1", brief("GOOD"));
  assert.deepEqual(codes.rows.GOOD, { status: "used", productId: PRODUCT, conversationId: "c1" });
});

for (const [reason, code, message] of [
  ["not_found", "NOPE", "兑换码不存在"], ["not_paid", "UNPAID", "尚未支付"], ["used", "TAKEN", "已被使用"], ["wrong_product", "OTHER", "不适用于此产品"]
] as const) {
  test(`a refused code (${reason}) stops the Run with a short Chinese reason`, async () => {
    const codes = new MemoryAccessCodes({
      UNPAID: { status: "pending", productId: PRODUCT, conversationId: null },
      TAKEN: { status: "used", productId: PRODUCT, conversationId: "someone-else" },
      OTHER: { status: "active", productId: "another-product", conversationId: null }
    });
    const error = await refusal(gateOver(codes).admit(PRODUCT, "c1", brief(code)));
    assert.equal(error?.code, `access_code_${reason}`);
    assert.equal(error?.message, message);
    assert.equal(error?.status, 403);
  });
}

test("IDEMPOTENT: the same conversation again, a reload or a retry, spends no second code", async () => {
  const codes = new MemoryAccessCodes({ GOOD: { status: "active", productId: PRODUCT, conversationId: null } });
  const gate = gateOver(codes);
  await gate.admit(PRODUCT, "c1", brief("GOOD"));
  await gate.admit(PRODUCT, "c1", brief("GOOD"));
  await Promise.all([gate.admit(PRODUCT, "c1", brief("GOOD")), gate.admit(PRODUCT, "c1", brief("GOOD"))]);
  assert.equal(codes.rows.GOOD!.conversationId, "c1");
  assert.equal((await refusal(gate.admit(PRODUCT, "c2", brief("GOOD"))))?.code, "access_code_used");
});

test("a Brief with no code, or a Product with the capability and no adapter, never runs", async () => {
  const codes = new MemoryAccessCodes({});
  const noCode = createBriefSnapshot({ contract_version: "1", fields: [{ id: "website", label: "网址", required: true }] }, [{ field_id: "website", value: "x.com" }]);
  assert.equal((await refusal(gateOver(codes).admit(PRODUCT, "c1", noCode)))?.code, "access_code_not_found");
  assert.equal((await refusal(gateOver(undefined).admit(PRODUCT, "c1", brief("GOOD"))))?.code, "access_codes_unavailable");
  assert.equal(codes.redeemed, 0);
});

test("a Product without the access_code capability is not asked for a code", async () => {
  const codes = new MemoryAccessCodes({});
  await gateOver(codes, false).admit(PRODUCT, "c1", undefined);
  assert.equal(codes.redeemed, 0);
});

test("a used code opens the conversation it was used for; any other code does not", async () => {
  const codes = new MemoryAccessCodes({
    USED: { status: "used", productId: PRODUCT, conversationId: "durable-1" },
    FRESH: { status: "active", productId: PRODUCT, conversationId: null },
    ELSEWHERE: { status: "used", productId: "another-product", conversationId: "durable-9" }
  });
  const gate = gateOver(codes);
  assert.equal(await gate.usedBy(PRODUCT, brief("USED")), "durable-1");
  assert.equal(await gate.usedBy(PRODUCT, brief("FRESH")), undefined);
  assert.equal(await gate.usedBy(PRODUCT, brief("NOPE")), undefined);
  assert.equal(await gate.usedBy(PRODUCT, brief("ELSEWHERE")), undefined);
});

test("a Product with an access code opens a conversation only to the code it was used for", async () => {
  const codes = new MemoryAccessCodes({
    ONE: { status: "used", productId: PRODUCT, conversationId: "durable-1" },
    TWO: { status: "used", productId: PRODUCT, conversationId: "durable-2" }
  });
  const conversations: Record<string, { ownerAccountId: string; publicId: string }> = {
    "durable-1": { ownerAccountId: "guest:aaa", publicId: "conv_1" }, "durable-2": { ownerAccountId: "guest:bbb", publicId: "conv_2" }
  };
  const inner = { resolveIdentity: async (token?: string) => token ? { sub: `guest:${token}` } : undefined };
  const resolver = new AccessCodeIdentityResolver(inner, codes, async (id) => conversations[id]);
  const gate = gateOver(codes);
  const session = async (token: string) => {
    const identity = (await resolver.resolveIdentity(token))!;
    return { productId: PRODUCT, ...identity.only ? { only: identity.only } : {}, sub: identity.sub };
  };

  // The used code: the same conversation, as its owner, from any browser.
  const holder = await session("hatch_code.ONE~stranger");
  assert.equal(holder.sub, "guest:aaa");
  assert.equal(await gate.opens(holder, "conv_1"), true);
  // A code for a different conversation: not this one.
  assert.equal(await gate.opens(holder, "conv_2"), false);
  // A wrong code, or none: nothing, even for the conversation's own browser.
  assert.equal(await gate.opens(await session("hatch_code.WRONG~aaa"), "conv_1"), false);
  assert.equal(await gate.opens(await session("aaa"), "conv_1"), false);
  assert.equal(await gate.opens(await session("hatch_code.FRESH~aaa"), "conv_1"), false);
});
