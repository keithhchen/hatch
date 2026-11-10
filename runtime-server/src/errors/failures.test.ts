import assert from "node:assert/strict";
import test from "node:test";
import { FailureBoundary, type FailureRecord } from "./failures.js";
import { UpstreamError } from "./upstream.js";
import { failureOf } from "../factoryAgents/runFailure.js";

const QUOTA = '429 {"error":{"message":"Your account org-abc<ak-xyz> is suspended due to insufficient balance","type":"exceeded_current_quota_error"}} sk-live-secret moonshot';
const quiet = <T>(work: () => T): T => { const log = console.error; console.error = () => undefined; try { return work(); } finally { console.error = log; } };
const boundary = () => { const records: FailureRecord[] = []; const b = new FailureBoundary(); b.attach({ record: async r => { records.push(r); } }); return { b, records }; };

test("provider failures are classified by cause, provider and status", () => {
  const cases: Array<[string, string]> = [
    [QUOTA, "quota"], ["429 account suspended", "quota"], ["429 Too Many Requests", "rate_limited"],
    ["rate limit reached for requests", "rate_limited"], ["503 upstream connect error", "transient"], ["401 invalid api key", "configuration"]
  ];
  for (const [text, kind] of cases) assert.equal(UpstreamError.of(new Error(text)).kind, kind, text);
  const quota = UpstreamError.of(new Error(QUOTA));
  assert.deepEqual([quota.provider, quota.status], ["moonshot", 429]);
  assert.equal(UpstreamError.of(new Error("tool blew up")).kind, "unknown");
});

test("an upstream failure reaches clients only as upstream_error with a reference, never the provider's words", () => {
  const { b } = boundary();
  const failure = quiet(() => b.translate(UpstreamError.of(new Error(QUOTA)), { run: "r1" }));
  assert.equal(failure.code, "upstream_error");
  assert.match(failure.reference!, /^err_[0-9a-f]{12}$/);
  assert.equal(failure.message, `An upstream service Hatch uses failed. This is not a problem with your account. Reference: ${failure.reference}.`);
  assert.doesNotMatch(JSON.stringify(failure), /org-abc|ak-xyz|sk-live|quota|balance|suspended|moonshot/i);
});

test("the cause stays server-side: logged once and recorded redacted under the reference", async () => {
  const { b, records } = boundary();
  const lines: string[] = [];
  const log = console.error;
  console.error = (line: string) => { lines.push(line); };
  let failure;
  try { failure = b.translate(UpstreamError.of(new Error(QUOTA)), { run: "r1", conversation: "c1" }); } finally { console.error = log; }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), { event: "failure", ...records[0] });
  const [record] = records;
  assert.equal(record!.reference, failure.reference);
  assert.deepEqual(record!.scope, { run: "r1", conversation: "c1" });
  assert.deepEqual(record!.cause, { kind: "quota", provider: "moonshot", status: 429 });
  assert.doesNotMatch(JSON.stringify(record), /org-abc|ak-xyz|sk-live/);
});

test("an error that is not upstream keeps its message, even when it mentions a timeout", () => {
  assert.equal(quiet(() => boundary().b.translate(new Error("MCP call timed out after 25ms"))).message, "MCP call timed out after 25ms");
});

test("Hatch's own errors keep their message", () => {
  const failure = quiet(() => boundary().b.translate(new Error("tool blew up tvly-abc123")));
  assert.equal(failure.code, "run_failed");
  assert.equal(failure.message, "tool blew up [redacted]");
  assert.match(failure.reference!, /^err_/);
});

test("guard hands one translated failure to the caller and returns the result otherwise", async () => {
  const { b } = boundary();
  const seen: string[] = [];
  assert.equal(await b.guard({}, async () => 7, f => { seen.push(f.code); }), 7);
  assert.equal(await quiet(() => b.guard({}, async () => { throw UpstreamError.of(new Error("503 upstream")); }, f => { seen.push(f.code); })), undefined);
  assert.deepEqual(seen, ["upstream_error"]);
});

test("a failed session reads back its code, message and reference; older ones read as run_failed", () => {
  assert.deepEqual(failureOf({ error: "m", errorCode: "upstream_error", errorRef: "err_1" }), { code: "upstream_error", message: "m", reference: "err_1" });
  assert.deepEqual(failureOf({}), { code: "run_failed", message: "The Run failed. Send the message again." });
});
