# Hatch developer guide

Same content as https://gethatchapp.com/developers.

## CLI

### 1. Install the CLI

Node 20 or newer.

```sh
npm install -g https://gethatchapp.com/downloads/hatch-cli.tgz
```

```sh
hatch --help
```

### 2. Sign in

`hatch login` opens the browser. Or create an API key and pipe it in; the key is shown once.

API keys: https://gethatchapp.com/studio/settings#api-keys

```sh
hatch login
hatch whoami
```

```sh
printf %s "$HATCH_API_KEY" | hatch login --api-key-stdin
```

### 3. List your products

```sh
hatch products list
```

### 4. Create a product

```sh
hatch products create --name "My agent" --promise "What it does for customers"
```

### 5. Ingest links and files

Up to 50 items and 30 MB of files per call. `--wait` polls every 5 seconds.

```sh
hatch ingest <product-id> https://example.com/post ./notes.pdf --context "Why these sources" --wait
```

### 6. Check the job

```sh
hatch ingest status <product-id> <job-id>
hatch ingest list <product-id>
```

### 7. Talk to workers

```sh
hatch workers <product-id>
```

### 8. Send a message

```sh
hatch chat <product-id> research "Summarize what we know about the expert" --wait
```

### 9. Read the history

```sh
hatch history <product-id> research --after <message-id>
```

### 10. Stop a worker

```sh
hatch stop <product-id> research
```

### 11. Talk to the Assistant

```sh
hatch assistant "What needs my attention?" --wait
hatch assistant history
```

`chat` and `assistant` also take `--stream` (print the reply as it arrives) and `--key <client_message_id>`. Every send carries a `client_message_id`; to retry a send safely, pass the same key again.

### 12. Chat with a published product

Consumer Chat is a different system from the workers above: a conversation between your account and a published Product.

```sh
hatch conversations
hatch ask "What do you recommend?" --product <product-id> --wait      # starts a conversation, prints conversation_id
hatch ask "And for a beginner?" --conversation <conversation-id> --stream
hatch conversation show <conversation-id>                              # history, state, run_id, cursor
hatch conversation watch <conversation-id> --after <cursor>            # resume after a dropped connection
hatch conversation stop <conversation-id> <run-id>
```

The Run belongs to the server. Closing the CLI or losing the connection never stops it; only `conversation stop` does. A stream that drops reconnects after the last cursor and does not repeat text; if it gives up, it prints the cursor to resume from.

## HTTP API

### 1. Create an API key

The key is shown once. Send it as a Bearer token.

API keys: https://gethatchapp.com/studio/settings#api-keys

```sh
export HATCH_API_KEY=...
curl -s https://gethatchapp.com/v1/auth/me -H "Authorization: Bearer $HATCH_API_KEY"
```

### 2. List your products

```sh
curl -s https://gethatchapp.com/v1/creator/products -H "Authorization: Bearer $HATCH_API_KEY" \
  | jq '.products[] | {product_id, name, status}'
```

### 3. Create a product

```sh
PRODUCT_ID=$(curl -s -X POST https://gethatchapp.com/v1/creator/products -H "Authorization: Bearer $HATCH_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"My agent","promise":"What it does for customers"}' \
  | jq -r '.product.product_id')
```

### 4. Update a product

PATCH needs `promise` and `expected_updated_at`, the `updated_at` of the product you read.

```sh
curl -s https://gethatchapp.com/v1/creator/products/$PRODUCT_ID -H "Authorization: Bearer $HATCH_API_KEY"
```

```sh
curl -s -X PATCH https://gethatchapp.com/v1/creator/products/$PRODUCT_ID -H "Authorization: Bearer $HATCH_API_KEY" -H "Content-Type: application/json" \
  -d '{"promise":"A sharper promise","expected_updated_at":"<updated_at from the GET>"}'
```

### 5. Unlist or list a product

```sh
curl -s -X PUT https://gethatchapp.com/v1/creator/products/$PRODUCT_ID/listing -H "Authorization: Bearer $HATCH_API_KEY" -H "Content-Type: application/json" \
  -d '{"listed":false}'
```

### 6. Ingest links

Returns 202 with a job. Up to 50 items per call; the request body is limited to 32 MB.

```sh
JOB_ID=$(curl -s -X POST https://gethatchapp.com/v1/creator/products/$PRODUCT_ID/ingest -H "Authorization: Bearer $HATCH_API_KEY" -H "Content-Type: application/json" \
  -d '{"items":[{"url":"https://example.com/post"}],"context":"Why these sources"}' \
  | jq -r '.job.id')
```

### 7. Ingest a file

Inline files total at most 30 MB. `media_type` is optional.

```sh
{ printf '{"items":[{"name":"notes.pdf","media_type":"application/pdf","content_base64":"'
  base64 -i notes.pdf | tr -d '\n'
  printf '"}]}'; } \
  | curl -s -X POST https://gethatchapp.com/v1/creator/products/$PRODUCT_ID/ingest -H "Authorization: Bearer $HATCH_API_KEY" -H "Content-Type: application/json" --data-binary @-
```

### 8. Check the job

Job: queued, running, done, failed. Item: pending, ok, partial, failed.

```sh
curl -s https://gethatchapp.com/v1/creator/products/$PRODUCT_ID/ingest/$JOB_ID -H "Authorization: Bearer $HATCH_API_KEY" | jq '.job | {status, items}'
curl -s https://gethatchapp.com/v1/creator/products/$PRODUCT_ID/ingest -H "Authorization: Bearer $HATCH_API_KEY"
```

```json
{
  "job": {
    "id": "…",
    "product_id": "…",
    "status": "queued | running | done | failed",
    "items": [
      { "id": "…", "input": "…", "status": "pending | ok | partial | failed", "markdown_path": "…", "original_ref": "…", "error": "…" }
    ],
    "created_at": "…",
    "updated_at": "…",
    "error": "…"
  }
}
```

### 9. Talk to workers

```sh
curl -s https://gethatchapp.com/v1/creator/products/$PRODUCT_ID/workers -H "Authorization: Bearer $HATCH_API_KEY" \
  | jq '.workers[] | {id, availability, status}'
```

### 10. Send a message

```sh
curl -s -X POST "https://gethatchapp.com/v1/creator/products/$PRODUCT_ID/workers/research/messages?wait=60" -H "Authorization: Bearer $HATCH_API_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"content":"Summarize what we know about the expert"}' \
  | jq '{status, reply}'
```

### 11. Read the history

```sh
curl -s "https://gethatchapp.com/v1/creator/products/$PRODUCT_ID/workers/research/messages?after=$MESSAGE_ID" -H "Authorization: Bearer $HATCH_API_KEY"
```

```json
{
  "status": "idle | running | failed",
  "messages": [
    { "id": "…", "role": "user | assistant", "text": "…", "created_at": "…" }
  ]
}
```

### 12. Watch events

```sh
curl -N https://gethatchapp.com/v1/creator/products/$PRODUCT_ID/workers/research/events -H "Authorization: Bearer $HATCH_API_KEY"
```

### 13. Stop a worker

```sh
curl -s -X POST https://gethatchapp.com/v1/creator/products/$PRODUCT_ID/workers/research/stop -H "Authorization: Bearer $HATCH_API_KEY" -H "Content-Type: application/json" -d '{}'
```

### 14. Talk to the Assistant

```sh
curl -s -X POST "https://gethatchapp.com/v1/creator/assistant/conversation/messages?wait=60" -H "Authorization: Bearer $HATCH_API_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"content":"What needs my attention?"}'
```

Send an Idempotency-Key to make retries safe; without it a retry may create a duplicate. This holds for every write to a worker or the Assistant (`messages`, `retry`, task `approve`/`decline`/`answer`): use one new UUID per action and the same one on a retry. `Accept: text/event-stream` on the POST streams the reply; `GET .../events?after_cursor=<cursor>` resumes it.

Beyond the shared verbs, the Assistant conversation has additions that Studio's own page uses. They only add fields and routes: nothing above changes. All are under `/v1/creator/assistant/conversation`.

| Route | What it does |
|---|---|
| `GET /view?limit=` | `snapshot` of the newest messages (default and most 200), plus `has_more`, `before_cursor`, `tasks` (what waits on you) and `channels` (the chat platforms you can reach the Assistant on). |
| `GET /messages?before=<before_cursor>&limit=` | The page of messages before that cursor, newest page last: `{ status, messages, has_more, before_cursor }`. The cursor is opaque. Not with `after`. A worker answers `501 history_unavailable`. |
| `GET /assets/<asset_id>` | The picture you uploaded, as an image. `404 asset_not_found` for anything else. |
| `PUT /timezone` | `{"timezone":"Asia/Shanghai"}` tells the Assistant your hours. `400 invalid_timezone` for anything that is not an IANA name. Reading never sets it. |

An Assistant reply may carry `steps`: `{ "parts": [...], "tool_calls": [{ "tool_call_id", "name", "status", "activity_message" }] }`, what the Assistant did inside that reply. Why the last Run failed is `status.error` on `snapshot`, `view` and `messages` (`status` is `failed`). Upload a file as the raw request body: `POST /assets?name=<file name>`.

### 15. Chat with a published product

The Chat API is described in `docs/spec-surfaces-v1.md`. Same API key or browser session. Usage is counted per surface: Studio web, Studio API (Studio calls made with an API key), Chat web and Responses API.

```sh
curl -s -X POST https://gethatchapp.com/v1/conversations -H "Authorization: Bearer $HATCH_API_KEY" -H "Content-Type: application/json" -d '{"product_id":"'"$PRODUCT_ID"'"}'
curl -s -X POST "https://gethatchapp.com/v1/conversations/$CONVERSATION_ID/messages?wait=60" -H "Authorization: Bearer $HATCH_API_KEY" -H "Content-Type: application/json" \
  -d '{"client_message_id":"'"$(uuidgen)"'","content":"What do you recommend?"}'
curl -N "https://gethatchapp.com/v1/conversations/$CONVERSATION_ID/events?after=$CURSOR" -H "Authorization: Bearer $HATCH_API_KEY"
curl -s -X POST "https://gethatchapp.com/v1/conversations/$CONVERSATION_ID/runs/$RUN_ID/cancel" -H "Authorization: Bearer $HATCH_API_KEY"
```

## MCP

### 1. Install the CLI and sign in

The MCP server runs locally over stdio and uses the CLI's sign-in.

```sh
npm install -g https://gethatchapp.com/downloads/hatch-cli.tgz
```

```sh
hatch login
```

### 2. Claude Code

```sh
claude mcp add hatch -- hatch mcp
```

### 3. Codex

```toml
# ~/.codex/config.toml
[mcp_servers.hatch]
command = "hatch"
args = ["mcp"]
```

### 4. Tools

Sign-in, sign-out and API keys stay human actions in the CLI. There is no remote (HTTP) MCP yet, so chat apps without a terminal cannot connect; use the HTTP API.

```sh
whoami
products_list  products_show  products_create  products_update  products_unlist
ingest_submit  ingest_status  ingest_list
```

### 5. Talk to workers

```sh
workers_list  worker_send  worker_history  worker_stop
assistant_send  assistant_history
```

Chat with a published product (send with `wait`; pass back `client_message_id` to retry):

```sh
conversations_list  chat_send  conversation_show  chat_stop
```

### 6. Agent skill

Teaches coding agents to use the CLI.

```sh
hatch install-skill -g
```

## Responses API

Chat with your live products from your own code through the OpenAI SDKs. Base URL: https://gethatchapp.com/responses/v1

### 1. Get an API key

The same Hatch API key as the Studio API. Create one in Studio Settings, API keys.

API keys: https://gethatchapp.com/studio/settings#api-keys

```sh
export HATCH_API_KEY=...
```

### 2. Install the SDK and set the base URL

The official OpenAI SDKs work unchanged. Base URL: `https://gethatchapp.com/responses/v1`.

```sh
pip install openai
```

```python
import os
from openai import OpenAI

client = OpenAI(base_url="https://gethatchapp.com/responses/v1", api_key=os.environ["HATCH_API_KEY"])
```

```sh
npm i openai
```

```javascript
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://gethatchapp.com/responses/v1", apiKey: process.env.HATCH_API_KEY });
```

### 3. List models

Each of your live products is a model, `hatch:<product_id>`. `task_brief.fields` lists the Task Brief fields the product asks for.

```python
for model in client.models.list():
    print(model.id)
```

```javascript
for await (const model of client.models.list()) console.log(model.id);
```

```sh
curl -s https://gethatchapp.com/responses/v1/models -H "Authorization: Bearer $HATCH_API_KEY" \
  | jq '.data[] | {id, task_brief}'
```

```json
{
  "id": "hatch:<product_id>",
  "object": "model",
  "task_brief": { "fields": [{ "id": "goal", "label": "Goal", "required": true }] }
}
```

### 4. Start a conversation with the Task Brief

`task_brief` maps field ids to values; a missing required field returns 400 `task_brief_required`. Only `metadata.title` is supported. A conversation id is all you need afterwards. You can also list conversations, read items, rename (POST) and archive (DELETE).

```python
conversation = client.conversations.create(
    metadata={"title": "Launch plan"},
    extra_body={"model": "hatch:<product_id>", "task_brief": {"goal": "Plan a launch"}},
)
print(conversation.id)
```

```javascript
const conversation = await client.conversations.create({
  model: "hatch:<product_id>",
  task_brief: { goal: "Plan a launch" },
  metadata: { title: "Launch plan" },
});
```

```sh
CONVERSATION_ID=$(curl -s -X POST https://gethatchapp.com/responses/v1/conversations -H "Authorization: Bearer $HATCH_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"hatch:<product_id>","task_brief":{"goal":"Plan a launch"},"metadata":{"title":"Launch plan"}}' \
  | jq -r '.id')
```

```sh
curl -s https://gethatchapp.com/responses/v1/conversations/$CONVERSATION_ID -H "Authorization: Bearer $HATCH_API_KEY"
curl -s "https://gethatchapp.com/responses/v1/conversations?model=hatch:<product_id>&limit=20" -H "Authorization: Bearer $HATCH_API_KEY"
curl -s https://gethatchapp.com/responses/v1/conversations/$CONVERSATION_ID/items -H "Authorization: Bearer $HATCH_API_KEY"
curl -s -X DELETE https://gethatchapp.com/responses/v1/conversations/$CONVERSATION_ID -H "Authorization: Bearer $HATCH_API_KEY"
```

### 5. Send a response

Without `stream` the request waits up to 90 seconds; if the run is still going it returns `status: in_progress`, so poll `GET /responses/{id}`. `background: true` returns immediately. `include: ["hatch.tool_calls"]` adds the Agent's server-side tool calls as `hatch_tool_call` items. An approval appears as `mcp_approval_request`; only denial is supported now. SDKs do not send an Idempotency-Key by default; pass one to make retries safe. A second response while one is running returns 409 `conversation_busy`. Every response carries `usage`; usage is counted per account in Studio, Settings, Usage, and a monthly cap may return 429 `insufficient_quota`.

```python
response = client.responses.create(
    model="hatch:<product_id>",
    conversation=conversation.id,
    input="Draft the announcement",
)
print(response.status, response.output_text, response.usage.total_tokens)
```

```javascript
const response = await client.responses.create({
  model: "hatch:<product_id>",
  conversation: conversation.id,
  input: "Draft the announcement",
});
console.log(response.status, response.output_text, response.usage.total_tokens);
```

```sh
curl -s -X POST https://gethatchapp.com/responses/v1/responses -H "Authorization: Bearer $HATCH_API_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"model":"hatch:<product_id>","conversation":"'"$CONVERSATION_ID"'","input":"Draft the announcement"}' \
  | jq '{id, status, output_text, usage}'
```

```python
client.responses.create(
    model="hatch:<product_id>",
    conversation=conversation.id,
    input="Draft the announcement",
    extra_headers={"Idempotency-Key": "launch-1"},
)
```

```sh
curl -s -X POST https://gethatchapp.com/responses/v1/responses -H "Authorization: Bearer $HATCH_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"hatch:<product_id>","conversation":"'"$CONVERSATION_ID"'","input":"Draft the announcement","background":true,"include":["hatch.tool_calls"]}'
curl -s https://gethatchapp.com/responses/v1/responses/$RESPONSE_ID -H "Authorization: Bearer $HATCH_API_KEY"
curl -s -X POST https://gethatchapp.com/responses/v1/responses/$RESPONSE_ID/cancel -H "Authorization: Bearer $HATCH_API_KEY"
```

### 6. Stream the response

Server-sent events, with a keep-alive comment every 15 seconds. `GET /responses/{id}?stream=true` re-streams a response.

```python
stream = client.responses.create(
    model="hatch:<product_id>",
    conversation=conversation.id,
    input="Draft the announcement",
    stream=True,
)
for event in stream:
    if event.type == "response.output_text.delta":
        print(event.delta, end="", flush=True)
```

```javascript
const stream = await client.responses.create({
  model: "hatch:<product_id>",
  conversation: conversation.id,
  input: "Draft the announcement",
  stream: true,
});
for await (const event of stream) {
  if (event.type === "response.output_text.delta") process.stdout.write(event.delta);
}
```

```sh
curl -N -X POST https://gethatchapp.com/responses/v1/responses -H "Authorization: Bearer $HATCH_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"hatch:<product_id>","conversation":"'"$CONVERSATION_ID"'","input":"Draft the announcement","stream":true}'
curl -N "https://gethatchapp.com/responses/v1/responses/$RESPONSE_ID?stream=true" -H "Authorization: Bearer $HATCH_API_KEY"
```

```text
response.created  response.in_progress
response.output_item.added  response.content_part.added
response.output_text.delta  response.output_text.done
response.content_part.done  response.output_item.done
response.completed | response.failed | response.incomplete
error
```

### 7. Continue a conversation

Pass `conversation`, or `previous_response_id` of the latest response in that conversation. An empty `input` on a new conversation starts the run from the Task Brief alone; `task_brief` is only accepted when a new conversation is created.

```python
followup = client.responses.create(
    model="hatch:<product_id>",
    previous_response_id=response.id,
    input="Shorter, please",
)
items = client.conversations.items.list(conversation.id)
```

```javascript
const followup = await client.responses.create({
  model: "hatch:<product_id>",
  previous_response_id: response.id,
  input: "Shorter, please",
});
```

```sh
curl -s -X POST https://gethatchapp.com/responses/v1/responses -H "Authorization: Bearer $HATCH_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"hatch:<product_id>","task_brief":{"goal":"Plan a launch"},"input":""}'
```

### 8. Errors and limits

Errors use the OpenAI shape. Not supported, returning 400 `unsupported_parameter` with `param`: `instructions`, `tools`, `tool_choice` other than auto, `text.format`, `reasoning`, `max_output_tokens`, system, developer or assistant input roles, `store: false`, and `metadata` other than `title`. Ignored: `temperature`, `top_p`, `user`, `service_tier`.

```json
{ "error": { "message": "…", "type": "conflict_error", "param": null, "code": "conversation_busy" } }
```

```text
401  invalid_api_key
404  model_not_found  conversation_not_found  response_not_found
409  conversation_busy  idempotency_key_reused
400  task_brief_required  unsupported_parameter
429  rate_limit_exceeded  insufficient_quota (usage_cap_exceeded)
500  internal_error
503  service_unavailable
```
