import assert from "node:assert/strict";
import test from "node:test";
import type { AccessCodes } from "./accessCodes.js";
import { MemoryAttemptLimiter, TooManyAttempts, clientIp, rateLimitedAccessCodes } from "./rateLimit.js";

// Only "MSC000001" is a good code.
const inner = {
  redeem: async ({ code }: { code: string }) => code === "MSC000001" ? { ok: true } : { ok: false, reason: "not_found" },
  lookup: async (code: string) => code === "MSC000001" ? { status: "used", source: "paid", productId: "p", conversationId: "c" } : null
} as unknown as AccessCodes;
const redeem = (codes: AccessCodes, code: string) => codes.redeem({ code, productId: "p", conversationId: "c" });

test("the 11th failed attempt in the window is refused with 429; successes do not count", async () => {
  let now = 0;
  const limiter = new MemoryAttemptLimiter(10, 600_000, () => now);
  const codes = rateLimitedAccessCodes(inner, limiter, "203.0.113.9");
  for (let i = 0; i < 20; i++) assert.deepEqual(await redeem(codes, "MSC000001"), { ok: true });
  for (let i = 0; i < 5; i++) assert.equal((await redeem(codes, "MSC999999")).ok, false);
  for (let i = 0; i < 5; i++) assert.equal(await codes.lookup("MSC999999"), null);
  await assert.rejects(redeem(codes, "MSC000001"), (error: unknown) => error instanceof TooManyAttempts && error.status === 429 && error.message === "尝试次数过多，请稍后再试");
  await assert.rejects(codes.lookup("MSC000001"), TooManyAttempts);

  // Another client is unaffected; this one is let in again once its failures age out.
  assert.deepEqual(await redeem(rateLimitedAccessCodes(inner, limiter, "198.51.100.1"), "MSC000001"), { ok: true });
  now = 600_001;
  assert.deepEqual(await redeem(codes, "MSC000001"), { ok: true });
});

test("a client without a known address is not let through", async () => {
  await assert.rejects(redeem(rateLimitedAccessCodes(inner, new MemoryAttemptLimiter(), undefined), "MSC000001"), TooManyAttempts);
});

test("the client address: X-Real-IP, else the first X-Forwarded-For hop, valid addresses only", () => {
  assert.equal(clientIp({ "x-real-ip": "2001:db8::7", "x-forwarded-for": "203.0.113.9" }), "2001:db8::7");
  assert.equal(clientIp({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }), "203.0.113.9");
  assert.equal(clientIp({ "x-real-ip": "bogus", "x-forwarded-for": "198.51.100.4" }), "198.51.100.4");
  assert.equal(clientIp({ "x-real-ip": "bogus" }), undefined);
});
