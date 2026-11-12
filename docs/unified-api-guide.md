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

API keys: https://gethatchapp.com/studio/api-keys

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

API keys: https://gethatchapp.com/studio/api-keys

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

### 15. Chat with a published product

The Chat API is described in `docs/spec-surfaces-v1.md`. Same API key or browser session.

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
