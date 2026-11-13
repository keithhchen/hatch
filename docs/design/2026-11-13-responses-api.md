# Hatch Responses API + usage metering — contract (2026-11-13)

Decided by the product owner: the public consumer-side Chat API is **stateful** and modelled on the **OpenAI Responses API** (not Chat Completions). Hatch is an agent provider: conversations, Task Brief, tool progress and compaction live on the server. The expert uses the **same API key** as the Studio API to chat with **any of their own live products** through one endpoint.

Architecture rule: the Responses API is an **HTTP adapter** over the existing chat domain (ChatService / ChatRuntime / conversation repository / ChatAssets / brief). No business rule lives only in the adapter; translate shapes, statuses and events. New code lives in `runtime-server/src/responses/` (one module per concern: auth, models, conversations, responses, stream, files, errors, mapping). No changes to the existing `/v1/conversations` contract.

## Base URL and auth
- Base URL: `https://gethatchapp.com/responses/v1` — the official OpenAI SDKs work unchanged: `OpenAI(base_url="https://gethatchapp.com/responses/v1", api_key=HATCH_API_KEY)`.
- Caddy routes `/responses/v1/*` to Runtime (8400), like `/v1/conversations*`.
- `Authorization: Bearer <Hatch API key>` (also accept a normal session token). Missing/invalid/expired → **401** `invalid_api_key`. Never 403 for bad credentials.
- Runtime learns the caller from Registry. Registry must also return the session id and `client_type` (api_key | web | cli | …) so usage can be attributed to a key. Cache successful verifications in Runtime for ≤30 s (key revocation takes effect within 30 s).
- Every response echoes `x-request-id` (use the inbound one or mint one).
- Scope: owner path only — the caller chats with products whose creator is the caller and that have a live release.

## Models — `GET /responses/v1/models`, `GET /responses/v1/models/{model}`
- Each live product the caller owns is a model. `id` = `hatch:<product_id>` (also accept the bare product id on input).
- Object: `{ id, object: "model", created, owned_by: "<creator display name or id>", name, description, task_brief: { fields: [{ id, label, required }] } | null }` (`task_brief` is a Hatch extension; extra fields are ignored by SDKs).
- Unknown, not-owned or not-live product → **404** `model_not_found` (same for every endpoint that takes `model`).

## Conversations (OpenAI Conversations API shape)
- `POST /responses/v1/conversations` body: `{ model (required, Hatch extension), metadata?, task_brief?: { "<field_id>": "<value>", … }, items?: [] }`. `items` (initial items) are not supported in v1: non-empty → 400 `unsupported_parameter`, param `items`.
  - `task_brief` validated by the existing brief rules (required fields, unknown/duplicate fields, length caps). Missing required → **400** `task_brief_required`, `param: "task_brief.<field_id>"`. Other brief errors → 400 `invalid_task_brief`.
  - Returns `{ id: "conv_…", object: "conversation", created_at, metadata, model, task_brief: <snapshot fields+values> | null }`.
  - Idempotency: `Idempotency-Key` header → existing `client_request_id`.
- `GET /responses/v1/conversations/{id}` → same object. `POST /responses/v1/conversations/{id}` `{ metadata }` updates metadata (title may map to metadata.title). `DELETE` → archive; returns `{ id, object: "conversation.deleted", deleted: true }`.
- `GET /responses/v1/conversations?model=&limit=&after=` (Hatch extension, list newest first) → `{ object: "list", data, first_id, last_id, has_more }`.
- `GET /responses/v1/conversations/{id}/items?limit=&order=asc|desc&after=` → OpenAI items: user messages `{ type:"message", role:"user", content:[input_text|input_image|input_file] }`, assistant `{ type:"message", role:"assistant", content:[{type:"output_text", text, annotations:[]}] }`, approval items (below). Server tool activity appears only with `include=hatch.tool_calls`.
- A conversation id alone must resolve (owner-scoped lookup); callers never pass `product_id` again after creation.

## Responses — `POST /responses/v1/responses`
Request:
- `model` (required unless `conversation`/`previous_response_id` already implies it; if both given and they disagree → 400 `model_conversation_mismatch`).
- `input`: string, or array of items: `{ role:"user", content: string | [ {type:"input_text", text}, {type:"input_image", image_url | file_id}, {type:"input_file", file_id | file_data (data URL) | file_url, filename} ] }`, and `{ type:"mcp_approval_response", approval_request_id, approve, reason? }`. Only `user` role messages are accepted (system/developer/assistant input → 400 `unsupported_parameter`, param `input[n].role`): the Agent owns its instructions.
- `conversation`: `"conv_…"` or `{ id }`. Absent and no `previous_response_id` → a new conversation is created for `model` (with `task_brief` if given). `previous_response_id` → continue that response's conversation.
- `task_brief` (Hatch extension): only when a new conversation is created; otherwise → 400 `unsupported_parameter`.
- Empty `input` is allowed only for a new conversation with a Task Brief: starts the run from the brief alone (existing task-start behaviour).
- `stream` (bool), `background` (bool), `metadata`, `store` (must be true or absent; false → 400 `unsupported_parameter`), `include` (supports `hatch.tool_calls`).
- `instructions`, `tools` (non-empty), `tool_choice` other than "auto", `text.format` json schema, `reasoning`, `max_output_tokens`, `parallel_tool_calls`, `truncation`, `prompt`: not supported → 400 `unsupported_parameter` with `param`. `temperature`, `top_p`, `user`, `service_tier`, `prompt_cache_key`, `safety_identifier`: accepted and ignored (documented).
- Idempotency: `Idempotency-Key` header → `client_message_id` (same key + same input → the same response; different input → 409 `idempotency_key_reused`). Absent → server generates one (a retry may then create a duplicate — documented).
- A response already in progress on the conversation → **409** `conversation_busy` (no implicit steering on this API). Must be atomic in the domain (add a start-only mode to submit), not a check-then-act in the adapter.

Response object:
```
{ id: "resp_<run id>", object: "response", created_at, status: "queued"|"in_progress"|"completed"|"failed"|"cancelled"|"incomplete",
  model: "hatch:<product_id>", conversation: { id }, previous_response_id: null|…, metadata,
  output: [ { type:"message", id:"msg_…", role:"assistant", status:"completed", content:[ { type:"output_text", text, annotations:[] } ] },
            { type:"mcp_approval_request", id, server_label:"hatch", name, arguments }   // when a tool needs the caller's approval
            /* with include=hatch.tool_calls: { type:"hatch_tool_call", id, name, status, arguments, output } */ ],
  output_text (SDK convenience, joined text), error: null | { code, message }, incomplete_details: null | { reason },
  usage: { input_tokens, input_tokens_details:{ cached_tokens }, output_tokens, output_tokens_details:{ reasoning_tokens }, total_tokens } }
```
- Run failure → `status:"failed"`, `error:{ code, message }` (existing failure code; reference id in message). Content filter (Hatch's output guard or the provider's own safety stop) → `incomplete`, `{reason:"content_filter"}`. Output limit reached → `incomplete`, `{reason:"max_output_tokens"}`. Interrupted by restart → `failed` with code `run_interrupted`.
- `usage` = sum over every model call of the run (from the persisted per-call Usage).

Delivery modes:
- `stream: true` → SSE (`Content-Type: text/event-stream`, no gzip, `: keep-alive` comment every 15 s). Events (each `{ type, sequence_number, … }`, `event:` line = type): `response.created`, `response.in_progress`, `response.output_item.added`, `response.content_part.added`, `response.output_text.delta {item_id, output_index, content_index, delta}`, `response.output_text.done`, `response.content_part.done`, `response.output_item.done`, then exactly one of `response.completed` | `response.failed` | `response.incomplete` (full response object), or `error` for stream-level errors. With `include=hatch.tool_calls`, server tool activity streams as `response.output_item.added/done` of `hatch_tool_call` items. Approval → `response.output_item.done` with the `mcp_approval_request` item, then `response.completed` with status `incomplete`, `incomplete_details.reason: "approval_required"`; the client continues by sending `mcp_approval_response` in a new response on the same conversation.
- `stream: false`, `background: false` → hold the request until the run is terminal, up to 90 s (stays under the Cloudflare 100 s limit). Not terminal by then → return the response object with `status: "in_progress"` (HTTP 200); the client polls.
- `background: true` → return immediately with `status: "queued"`/`"in_progress"`.
- `GET /responses/v1/responses/{id}` (poll; `?stream=true` re-streams from the start: replay persisted events then live), `POST /responses/v1/responses/{id}/cancel`, `GET /responses/v1/responses/{id}/input_items`. `DELETE /responses/{id}` → 400 `unsupported_parameter` (responses are part of the conversation record).

**Attachments and Files: built, not public yet (`HATCH_RESPONSES_ATTACHMENTS=on` turns them on).** By default `input_image` and `input_file` are 400 `unsupported_parameter` with `param` set to the content part (e.g. `input[0].content[1]`), and `/files*` is not routed (404 `not_found`). Docs do not mention them.

## Files — `POST /responses/v1/files` (multipart `file`, `purpose` ignored/accepted), `GET /files/{id}`, `GET /files/{id}/content`
- Account-scoped upload (limits: image 20 MB, file 50 MB, audio 20 MB; existing media rules). Bound to a conversation when first used in an input item. `file_id` = `file_…`.
- Inline `image_url: "data:…"` / `file_data` and `https://` URLs (fetched server-side, same limits, 10 s timeout) are accepted in input items.
- Errors: 413 `file_too_large`, 415 `unsupported_file_type`, 404 `file_not_found`.
- If account-scoped uploads need storage the asset service doesn't have, implement inline data/URL first and report the Files gap.

## Errors (OpenAI shape everywhere under /responses/v1)
`{ "error": { "message", "type", "param", "code" } }` with:
| status | type | code (examples) |
|---|---|---|
| 400 | invalid_request_error | unsupported_parameter, invalid_request, task_brief_required, invalid_task_brief, model_conversation_mismatch, empty_input, model_requires_local_tools |
| 401 | authentication_error | invalid_api_key |
| 403 | permission_error | access_denied (authenticated but not allowed) |
| 404 | not_found_error | model_not_found, conversation_not_found, response_not_found, file_not_found |
| 409 | conflict_error | conversation_busy, idempotency_key_reused, conversation_archived |
| 413 / 415 | invalid_request_error | file_too_large / unsupported_file_type |
| 429 | rate_limit_error | rate_limit_exceeded (concurrency) — with `retry-after` |
| 429 | insufficient_quota | usage_cap_exceeded |
| 500 | server_error | internal_error (generic message; real error logged with request id) |
| 503 | service_unavailable | service_unavailable (capacity, registry down) — with `retry-after` |

## Usage metering, dashboard, caps (phase 2)
- **One ledger.** Append-only `hatch_usage_events(id, account_id, surface, api_key_id null, product_id null, run_id null, model, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, created_at)` plus a daily rollup `hatch_usage_daily(account_id, surface, day, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens)` maintained with an atomic `INSERT … ON CONFLICT … DO UPDATE SET x = x + EXCLUDED.x` in the same transaction. Additive DDL only.
- `surface`: `responses_api` (Responses API), `chat_web` (web/desktop/channel product chat), `studio_web` and `studio_api` (Studio work: factory runs, Nodes, factory agents, Assistant; `studio_api` when the request was authenticated by an API key, which is then recorded as `api_key_id`, otherwise `studio_web`). Attribution: the account that pays = the product owner for owner chats; Studio = the expert. An existing three-surface ledger is migrated at boot (`chat_api` → `responses_api`; `studio` → `studio_api` where `api_key_id` is set, else `studio_web`; the daily rollup is rebuilt from events).
- **One hook**: record usage where a model call completes (the pi runtime already produces `Usage` per assistant message; compaction too) via a `UsageRecorder` port passed the attribution context; Studio paths (factory agents, Assistant workers, hosted ingest) call the same port.
- **Caps**: monthly token cap per account (`HATCH_MONTHLY_TOKEN_CAP`, default generous; per-account override later). Checked before starting any run on any surface from the rollup (month-to-date total). Over cap → 429 `insufficient_quota` / `usage_cap_exceeded` on the APIs and a real "monthly usage limit reached" state in the web UI. A run already in flight finishes.
- **Dashboard**: Studio → Settings → Usage: this month's tokens by surface (Studio web, Studio API, Chat web, Responses API), a small daily chart for the last 30 days, and cap progress. Endpoint `GET /v1/creator/usage?from&to` (owner). Responses API responses carry `usage`.

## Implementation notes (phase 1, where the code differs from the text above)
- `metadata` supports `title` only (conversation `metadata.title`); any other key, and any metadata on a response, is 400 `unsupported_parameter`. The domain keeps no other metadata and no column was added for it.
- Empty `input` also starts a task for an existing conversation that has a Task Brief and no run yet (the natural `POST /conversations` then `POST /responses` flow).
- `previous_response_id` must be the latest response of its conversation (conversations are linear), otherwise 400 `invalid_request`; a retry of the request that made a later response is replayed, not refused.
- `created` of a model is 0 (a Corpus carries no release time). `GET /conversations?after=` takes a conversation id.
- Approvals: a pending approval surfaces as `mcp_approval_request`. Only denying is supported (400 `unsupported_parameter` for `approve: true`): approving runs a tool on the caller's machine, and the API has none. The `mcp` client cannot reach local tools, so in practice no approval arises yet.
- Attachments and Files: built, not public yet (see above). Inline data URLs, https URLs (public addresses only, no redirects, 10 s, 20/50 MB by kind) and the Files API work only with `HATCH_RESPONSES_ATTACHMENTS=on`.
- Usage on a response is summed from the persisted per-call usage and is present once the run has ended. The run is billed to the owner on the `responses_api` surface under the API key's session id.

## Docs
- Developers page gets a "Responses API" (Chat API) section next to the Studio API: base URL, SDK snippet (Python, Node, curl), models, conversations with Task Brief, streaming, files, errors table, limits. `docs/unified-api-guide.md` gets the same.
