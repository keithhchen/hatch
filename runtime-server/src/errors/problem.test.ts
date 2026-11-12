import assert from "node:assert/strict";
import { test } from "node:test";
import { ZodError, z } from "zod";
import { BriefValidationError } from "../brief.js";
import { ChatError } from "../chat/principal.js";
import { ConversationRepositoryError } from "../conversationRepository.js";
import { ConversationError } from "../conversations/conversation.js";
import { EntitlementError } from "../entitlements.js";
import { toProblem } from "./problem.js";

const shape = (error: unknown) => { const { status, code } = toProblem(error); return [status, code]; };

test("typed errors keep their own status and code", () => {
  assert.deepEqual(toProblem(new ConversationError(404, "not_found", "gone", { x: 1 })), { status: 404, code: "not_found", message: "gone", details: { x: 1 } });
  assert.deepEqual(toProblem(new ChatError("conversation_busy", "wait", 409)), { status: 409, code: "conversation_busy", message: "wait" });
  assert.deepEqual(shape(new BriefValidationError("brief_spec_invalid", "bad")), [422, "brief_spec_invalid"]);
});

test("a repository refusal has one status whichever transport tells it", () => {
  const status = (code: ConstructorParameters<typeof ConversationRepositoryError>[0]) => toProblem(new ConversationRepositoryError(code, "m")).status;
  for (const code of ["conversation_not_found", "run_not_found"] as const) assert.equal(status(code), 404);
  for (const code of ["conversation_archived", "conversation_busy", "version_conflict", "client_message_conflict", "run_not_retryable"] as const) assert.equal(status(code), 409);
  assert.equal(status("conversation_binding_mismatch"), 403);
  for (const code of ["run_id_conflict", "submission_not_accepted"] as const) assert.equal(status(code), 400);
});

test("entitlement failures say 403 for access and 503 for an unavailable verifier, never the cause", () => {
  assert.deepEqual(shape(new EntitlementError("entitlement_not_found", "secret detail")), [403, "entitlement_required"]);
  const unavailable = toProblem(new EntitlementError("auth_registry_unavailable", "http://registry.internal down"));
  assert.deepEqual([unavailable.status, unavailable.code], [503, "authorization_unavailable"]);
  assert.doesNotMatch(unavailable.message, /internal/);
});

test("malformed requests are 400", () => {
  assert.deepEqual(shape(new RangeError("limit out of range")), [400, "invalid_request"]);
  assert.deepEqual(shape(Object.assign(new Error("x"), { code: "history_cursor_invalid" })), [400, "history_cursor_invalid"]);
  const zod = z.object({ run_id: z.string() }).safeParse({}).error as ZodError;
  assert.deepEqual(shape(zod), [400, "invalid_request"]);
  assert.match(toProblem(zod).message, /^run_id: /);
});

test("an unknown error is a generic 500 that never carries its text", () => {
  const problem = toProblem(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
  assert.deepEqual([problem.status, problem.code, problem.internal], [500, "internal_error", true]);
  assert.doesNotMatch(problem.message, /ECONNREFUSED|10\.0\.0\.5/);
  assert.equal(toProblem("a string").status, 500);
});
