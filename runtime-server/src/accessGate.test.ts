import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessCodes } from "./accessCodes/accessCodes.js";
import { ACCESS_CODE_CAPABILITY, AccessGate } from "./accessGate.js";
import { InMemoryProductCapabilities } from "./agentBox/capabilities.js";
import { briefAccessCode } from "./brief.js";
import { ChatError } from "./chat/principal.js";

import { MemoryAccessCodes, PRODUCT, auditBrief, gateOver } from "./accessGate.testkit.js";
const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as ChatError);

test("the Brief's access_code field is its code", () => {
  assert.equal(briefAccessCode(auditBrief(" MSC123456 ")), "MSC123456");
});

test("an active code is spent for the conversation before the Run", async () => {
  const codes = new MemoryAccessCodes({ MSC000001: { status: "active", productId: PRODUCT, conversationId: null } });
  await gateOver(codes).admit(PRODUCT, "c1", auditBrief("MSC000001"));
  assert.deepEqual(codes.rows.MSC000001, { status: "used", productId: PRODUCT, conversationId: "c1" });
});

for (const [reason, code, message] of [
  ["not_found", "MSC999999", "兑换码不存在"], ["not_paid", "MSC000002", "尚未支付"], ["used", "MSC000003", "已被使用"], ["wrong_product", "MSC000004", "不适用于此产品"]
] as const) {
  test(`a refused code (${reason}) stops the Run with a short Chinese reason`, async () => {
    const codes = new MemoryAccessCodes({
      MSC000002: { status: "pending", productId: PRODUCT, conversationId: null },
      MSC000003: { status: "used", productId: PRODUCT, conversationId: "someone-else" },
      MSC000004: { status: "active", productId: "another-product", conversationId: null }
    });
    const error = await refusal(gateOver(codes).admit(PRODUCT, "c1", auditBrief(code)));
    assert.equal(error?.code, `access_code_${reason}`);
    assert.equal(error?.message, message);
    assert.equal(error?.status, 403);
  });
}

test("IDEMPOTENT: the same conversation again, a reload or a retry, spends no second code", async () => {
  const codes = new MemoryAccessCodes({ MSC000001: { status: "active", productId: PRODUCT, conversationId: null } });
  const gate = gateOver(codes);
  await gate.admit(PRODUCT, "c1", auditBrief("MSC000001"));
  await Promise.all([gate.admit(PRODUCT, "c1", auditBrief("MSC000001")), gate.admit(PRODUCT, "c1", auditBrief("MSC000001"))]);
  assert.equal(codes.rows.MSC000001!.conversationId, "c1");
  assert.equal((await refusal(gate.admit(PRODUCT, "c2", auditBrief("MSC000001"))))?.code, "access_code_used");
});

test("no codes adapter: nothing starts", async () => {
  assert.equal((await refusal(gateOver(undefined).admit(PRODUCT, "c1", auditBrief("MSC000001"))))?.code, "access_codes_unavailable");
});

test("only a Product with the access_code capability asks for a code", async () => {
  assert.equal(await gateOver(undefined).required(PRODUCT), true);
  assert.equal(await gateOver(undefined, false).required(PRODUCT), false);
});
