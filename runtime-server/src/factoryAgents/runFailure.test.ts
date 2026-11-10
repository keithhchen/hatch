import assert from "node:assert/strict";
import test from "node:test";
import { classifyRunFailure, failureOf } from "./runFailure.js";

const classify = (text: string) => classifyRunFailure(new Error(text), error => `redacted: ${(error as Error).message}`);

test("provider quota, rate limit and other provider failures get stable codes and fixed messages", () => {
  const quota = classify('429 {"error":{"message":"Your account org-abc<ak-xyz> is suspended due to insufficient balance","type":"exceeded_current_quota_error"}}');
  assert.equal(quota.code, "provider_quota");
  assert.doesNotMatch(quota.message, /org-abc|ak-xyz|suspended/);
  assert.equal(classify("429 account suspended").code, "provider_quota");
  assert.equal(classify("429 Too Many Requests").code, "provider_rate_limited");
  assert.equal(classify("rate limit reached for requests").code, "provider_rate_limited");
  assert.equal(classify("503 upstream connect error").code, "provider_error");
  assert.doesNotMatch(classify("500 sk-live-secret leaked").message, /sk-live/);
});

test("any other failure is run_failed and keeps the caller's text", () => {
  assert.deepEqual(classify("tool blew up"), { code: "run_failed", message: "redacted: tool blew up" });
});

test("a failed session without a code reads as run_failed", () => {
  assert.deepEqual(failureOf({ error: "old text" }), { code: "run_failed", message: "old text" });
  assert.equal(failureOf({}).code, "run_failed");
});
