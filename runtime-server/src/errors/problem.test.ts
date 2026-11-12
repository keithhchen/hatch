import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { BriefValidationError } from "../brief.js";
import { ChatError } from "../chat/principal.js";
import { ConversationRepositoryError } from "../conversationRepository.js";
import { ConversationError } from "../conversations/conversation.js";
import { EntitlementError } from "../entitlements.js";
import { admissionStatus, toProblem } from "./problem.js";

const shape = (error: unknown) => { const { status, code } = toProblem(error); return [status, code]; };

test("typed errors keep their own status and code", () => {
  assert.deepEqual(toProblem(new ConversationError(404, "not_found", "gone", { x: 1 })), { status: 404, code: "not_found", message: "gone", details: { x: 1 } });
  assert.deepEqual(toProblem(new ChatError("conversation_busy", "wait", 409)), { status: 409, code: "conversation_busy", message: "wait" });
  assert.deepEqual(shape(new BriefValidationError("brief_spec_invalid", "bad")), [422, "brief_spec_invalid"]);
});

test("pinned: a raw repository refusal on the HTTP routes", () => {
  const status = (code: ConstructorParameters<typeof ConversationRepositoryError>[0]) => toProblem(new ConversationRepositoryError(code, "m")).status;
  for (const code of ["conversation_not_found", "run_not_found"] as const) assert.equal(status(code), 404);
  for (const code of ["conversation_busy", "version_conflict"] as const) assert.equal(status(code), 409);
  assert.equal(status("conversation_binding_mismatch"), 403);
  for (const code of ["conversation_archived", "client_message_conflict", "run_not_retryable", "run_id_conflict", "submission_not_accepted"] as const) assert.equal(status(code), 400);
});

test("pinned: a refusal while a message or retry is admitted", () => {
  for (const code of ["client_message_conflict", "conversation_archived", "conversation_busy", "run_not_retryable"]) assert.equal(admissionStatus(code), 409);
  assert.equal(admissionStatus("conversation_not_found"), 400);
});

test("entitlement failures say 403 for access and 503 for an unavailable verifier, never the cause", () => {
  assert.deepEqual(shape(new EntitlementError("entitlement_not_found", "secret detail")), [403, "entitlement_required"]);
  const unavailable = toProblem(new EntitlementError("auth_registry_unavailable", "http://registry.internal down"));
  assert.deepEqual([unavailable.status, unavailable.code], [503, "authorization_unavailable"]);
  assert.doesNotMatch(unavailable.message, /internal/);
  assert.deepEqual(shape(new EntitlementError("something_else", "x")), [500, "internal_error"]);
});

test("malformed requests", () => {
  assert.deepEqual(shape(new RangeError("limit out of range")), [400, "invalid_request"]);
  assert.deepEqual(shape(Object.assign(new Error("x"), { code: "history_cursor_invalid" })), [400, "history_cursor_invalid"]);
  // Pinned: a schema failure is a 500, as it is today.
  assert.deepEqual(shape(z.object({ run_id: z.string() }).safeParse({}).error), [500, "conversation_request_failed"]);
});

test("an unknown error is a generic 500 that never carries its text", () => {
  const problem = toProblem(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
  assert.deepEqual([problem.status, problem.code, problem.internal], [500, "conversation_request_failed", true]);
  assert.doesNotMatch(problem.message, /ECONNREFUSED|10\.0\.0\.5/);
  assert.equal(toProblem("a string").status, 500);
});
