import assert from "node:assert/strict";
import { test } from "node:test";
import { BriefValidationError } from "../brief.js";
import { ChatError } from "../chat/principal.js";
import { ConversationRepositoryError, type ConversationRunRecord } from "../conversationRepository.js";
import { EntitlementError } from "../entitlements.js";
import { isPublicAddress } from "./attachments.js";
import { cachingIdentityResolver } from "./auth.js";
import { ResponseEvents } from "./events.js";
import { ApiError, errorBody, toApiError } from "./errors.js";
import { responseIdOf, responseObject, runIdOf, statusOf, usageOf, type RunView } from "./mapping.js";
import { parseCreateResponse } from "./request.js";

const shape = (error: unknown) => { const { error: api } = toApiError(error); return [api.status, api.type, api.code]; };

test("errors: every domain refusal is told in the OpenAI shape the contract table gives", () => {
  assert.deepEqual(shape(new ChatError("conversation_busy", "busy", 409)), [409, "conflict_error", "conversation_busy"]);
  assert.deepEqual(shape(new ConversationRepositoryError("client_message_conflict", "x")), [409, "conflict_error", "idempotency_key_reused"]);
  assert.deepEqual(shape(new ConversationRepositoryError("conversation_archived", "x")), [409, "conflict_error", "conversation_archived"]);
  assert.deepEqual(shape(new ConversationRepositoryError("conversation_not_found", "x")), [404, "not_found_error", "conversation_not_found"]);
  assert.deepEqual(shape(new ChatError("product_requires_local_tools", "x", 409)), [400, "invalid_request_error", "model_requires_local_tools"]);
  assert.deepEqual(shape(new ChatError("too_large", "x", 413)), [413, "invalid_request_error", "file_too_large"]);
  assert.deepEqual(shape(new ChatError("unsupported_type", "x", 415)), [415, "invalid_request_error", "unsupported_file_type"]);
  assert.deepEqual(shape(new ChatError("user_run_capacity", "x", 429)), [429, "rate_limit_error", "rate_limit_exceeded"]);
  assert.deepEqual(shape(new ChatError("runtime_run_capacity", "x", 503)), [503, "service_unavailable", "service_unavailable"]);
  assert.deepEqual(shape(new EntitlementError("auth_registry_unavailable", "x")), [503, "service_unavailable", "service_unavailable"]);
  assert.deepEqual(shape(new EntitlementError("auth_invalid", "x")), [401, "authentication_error", "invalid_api_key"]);
  assert.deepEqual(shape(new EntitlementError("entitlement_required", "x")), [403, "permission_error", "access_denied"]);
  assert.deepEqual(shape(new BriefValidationError("brief_required_answer_missing", "x")), [400, "invalid_request_error", "task_brief_required"]);
  assert.deepEqual(shape(new BriefValidationError("brief_answer_invalid", "x")), [400, "invalid_request_error", "invalid_task_brief"]);
});

test("errors: retry-after travels with 429 and 503, and an unexpected failure is generic and marked internal", () => {
  assert.equal(toApiError(new ChatError("user_run_capacity", "x", 429)).error.retryAfterSeconds, 2);
  assert.equal(toApiError(new ChatError("runtime_run_capacity", "x", 503)).error.retryAfterSeconds, 5);
  const internal = toApiError(new Error("database password is hunter2"));
  assert.equal(internal.internal, true);
  assert.deepEqual(errorBody(internal.error), { error: { message: "The server had an error processing your request.", type: "server_error", param: null, code: "internal_error" } });
  assert.deepEqual(errorBody(new ApiError(400, "invalid_request_error", "unsupported_parameter", "m", "tools")).error, { message: "m", type: "invalid_request_error", param: "tools", code: "unsupported_parameter" });
});

const body = (extra: Record<string, unknown>) => parseCreateResponse({ model: "hatch:m", input: "hi", ...extra });
const refusal = (extra: Record<string, unknown>) => { try { body(extra); } catch (error) { return (error as ApiError).param; } return "accepted"; };

test("request: unsupported parameters name themselves; ignored ones pass", () => {
  assert.equal(refusal({ instructions: "x" }), "instructions");
  assert.equal(refusal({ tools: [{ type: "web_search" }] }), "tools");
  assert.equal(refusal({ tools: [] }), "accepted");
  assert.equal(refusal({ tool_choice: "auto" }), "accepted");
  assert.equal(refusal({ tool_choice: "none" }), "tool_choice");
  assert.equal(refusal({ store: false }), "store");
  assert.equal(refusal({ store: true }), "accepted");
  assert.equal(refusal({ truncation: "auto" }), "truncation");
  assert.equal(refusal({ text: { format: { type: "json_schema" } } }), "text.format");
  assert.equal(refusal({ temperature: 1, top_p: 1, user: "u", service_tier: "auto", prompt_cache_key: "k", safety_identifier: "s" }), "accepted");
  assert.equal(refusal({ input: [{ role: "developer", content: "x" }] }), "input[0].role");
  assert.equal(refusal({ input: [{ role: "user", content: [{ type: "input_image", file_id: 7 }] }] }), "input[0].content[0].file_id");
  assert.equal(refusal({ conversation: "conv_1", previous_response_id: "resp_1" }), "previous_response_id");
  assert.equal(refusal({ include: ["hatch.tool_calls"] }), "accepted");
  assert.equal(refusal({ include: ["file_search_call.results"] }), "include[0]");
});

test("request: input as a string, as messages with parts, and as an approval answer", () => {
  assert.deepEqual(body({ input: "" }).parts, []);
  assert.deepEqual(body({ input: [{ role: "user", content: "a" }, { type: "message", role: "user", content: [{ type: "input_text", text: "b" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }, { type: "input_file", file_url: "https://example.com/a.pdf", filename: "a.pdf" }] }] }).parts, [
    { type: "text", text: "a" }, { type: "text", text: "b" },
    { type: "image", source: { kind: "data", mediaType: "image/png", base64: "AAAA" } },
    { type: "file", source: { kind: "url", url: "https://example.com/a.pdf" }, filename: "a.pdf" }
  ]);
  const approval = body({ input: [{ type: "mcp_approval_response", approval_request_id: "call_1", approve: false, reason: "no" }] });
  assert.deepEqual(approval.approvals, [{ requestId: "call_1", approve: false, reason: "no", param: "input[0]" }]);
  assert.equal(refusal({ input: [{ type: "mcp_approval_response", approval_request_id: "c", approve: true }, { role: "user", content: "x" }] }), "input");
  assert.equal(refusal({ input: [{ role: "user", content: [{ type: "input_image", image_url: "http://insecure.example/a.png" }] }] }), "input[0].content[0].image_url");
});

const run = (over: Partial<ConversationRunRecord> = {}): ConversationRunRecord => ({
  id: "run_abc", conversationId: "c", clientMessageId: "m", status: "completed", corpusDigest: "d", createdAt: "2026-11-13T10:00:00.000Z", steeredCount: 0, consumedCount: 0, ...over
});
const view = (over: Partial<RunView> = {}): RunView => ({ run: run(), text: "hello", toolCalls: [], approvals: [], usage: null, includeToolCalls: false, ...over });
const conversation = { id: "private", publicId: "conv_1", productId: "p1", createdAt: "2026-11-13T10:00:00.000Z" } as never;

test("mapping: response ids round-trip with the run id", () => {
  assert.equal(responseIdOf("run_abc123"), "resp_abc123");
  assert.equal(runIdOf("resp_abc123"), "run_abc123");
  assert.equal(runIdOf("nope"), undefined);
});

test("mapping: a run's state is told as a response status", () => {
  assert.equal(statusOf(view()).status, "completed");
  assert.deepEqual(statusOf(view({ finishReason: "content_filter" })), { status: "incomplete", error: null, incomplete: { reason: "content_filter" } });
  assert.equal(statusOf(view({ run: run({ status: "queued" }) })).status, "queued");
  assert.equal(statusOf(view({ run: run({ status: "running" }) })).status, "in_progress");
  assert.equal(statusOf(view({ run: run({ status: "cancelled" }) })).status, "cancelled");
  assert.deepEqual(statusOf(view({ run: run({ status: "failed", failure: { code: "upstream_unavailable", message: "The model is busy.", reference: "ref_1" } }) })).error,
    { code: "upstream_unavailable", message: "The model is busy. (reference ref_1)" });
  assert.equal((statusOf(view({ run: run({ status: "interrupted" }) })).error as { code: string }).code, "run_interrupted");
  assert.deepEqual(statusOf(view({ run: run({ status: "waiting_for_tool" }), approvals: [{ toolCallId: "t", name: "n", arguments: {} }] })).incomplete, { reason: "approval_required" });
});

test("mapping: the response object has its output, text, usage and place in the conversation", () => {
  const out = responseObject(conversation, view({ previousRunId: "run_prev", usage: { total_tokens: 3 }, includeToolCalls: true,
    toolCalls: [{ tool_call_id: "t1", name: "web.search", status: "completed", arguments: { q: "x" }, result: { ok: true } }] })) as Record<string, any>;
  assert.equal(out.id, "resp_abc");
  assert.equal(out.model, "hatch:p1");
  assert.deepEqual(out.conversation, { id: "conv_1" });
  assert.equal(out.previous_response_id, "resp_prev");
  assert.equal(out.output_text, "hello");
  assert.deepEqual(out.output.map((item: { type: string }) => item.type), ["message", "hatch_tool_call"]);
  assert.deepEqual(out.output[1], { type: "hatch_tool_call", id: "hatch_call_t1", name: "web.search", status: "completed", arguments: "{\"q\":\"x\"}", output: "{\"ok\":true}" });
  const hidden = responseObject(conversation, view({ toolCalls: [{ tool_call_id: "t1", name: "n", status: "completed", arguments: {} }] })) as Record<string, any>;
  assert.deepEqual(hidden.output.map((item: { type: string }) => item.type), ["message"], "tool activity is shown only on request");
});

test("mapping: the ledger's total for a run is the response's usage", () => {
  assert.deepEqual(usageOf({ input: 150, cachedInput: 30, output: 25, reasoning: 5 }), {
    input_tokens: 150, input_tokens_details: { cached_tokens: 30 }, output_tokens: 25, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 175
  });
});

test("events: text streams as the OpenAI sequence with numbered events and one terminal event", () => {
  const seen: Array<Record<string, any>> = [];
  const events = new ResponseEvents("run_abc", (event) => seen.push(event));
  const final = responseObject(conversation, view({ text: "Hello world" }));
  events.created({ status: "in_progress" });
  events.text("Hello ");
  events.text("world");
  events.finish(final);
  events.finish(final);
  assert.deepEqual(seen.map((event) => event.type), [
    "response.created", "response.in_progress", "response.output_item.added", "response.content_part.added",
    "response.output_text.delta", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"
  ]);
  assert.deepEqual(seen.map((event) => event.sequence_number), seen.map((_, index) => index));
  assert.deepEqual(seen[2]!.item.content, []);
  assert.equal(seen[6]!.text, "Hello world");
  assert.equal(seen.at(-1)!.response, final);
});

test("events: a replay with no live text tells the whole reply, a failure ends in response.failed, tool items keep the reply first", () => {
  const replay: Array<Record<string, any>> = [];
  new ResponseEvents("run_abc", (event) => replay.push(event)).finish(responseObject(conversation, view({ text: "all at once" })));
  assert.equal(replay.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join(""), "all at once");

  const failed: Array<Record<string, any>> = [];
  new ResponseEvents("run_abc", (event) => failed.push(event)).finish(responseObject(conversation, view({ text: "", run: run({ status: "failed", failure: { code: "run_failed", message: "no" } }) })));
  assert.deepEqual(failed.map((event) => event.type), ["response.failed"]);

  const tools: Array<Record<string, any>> = [];
  const stream = new ResponseEvents("run_abc", (event) => tools.push(event));
  stream.item({ type: "hatch_tool_call", id: "hatch_call_1" }, false);
  stream.item({ type: "hatch_tool_call", id: "hatch_call_1", status: "completed" }, true);
  assert.deepEqual(tools.map((event) => [event.type, event.output_index]), [
    ["response.output_item.added", 0], ["response.content_part.added", 0], ["response.output_item.added", 1], ["response.output_item.done", 1]
  ]);
});

test("auth: a verification is cached for the window, never past the session's expiry, and a refusal is never cached", async () => {
  let calls = 0;
  let now = 1_000_000;
  const known = new Map<string, { sub: string; exp?: number }>([["good", { sub: "a" }], ["short", { sub: "b", exp: 1_000_000 / 1000 + 10 }]]);
  const cached = cachingIdentityResolver({ async resolveIdentity(token) { calls += 1; return token ? known.get(token) : undefined; } }, 30_000, () => now);
  await cached.resolveIdentity("good"); await cached.resolveIdentity("good");
  assert.equal(calls, 1);
  now += 29_000; await cached.resolveIdentity("good");
  assert.equal(calls, 1);
  now += 2_000; await cached.resolveIdentity("good");
  assert.equal(calls, 2, "30 s is the most a revocation can take");
  await cached.resolveIdentity("short"); now += 11_000; await cached.resolveIdentity("short");
  assert.equal(calls, 4, "not cached past the session's own expiry");
  await cached.resolveIdentity("bad"); await cached.resolveIdentity("bad");
  assert.equal(calls, 6);
});

test("attachments: only the public internet may be fetched", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "not-an-ip"]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
});
