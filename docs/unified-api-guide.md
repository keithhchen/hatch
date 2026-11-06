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

### 5. Agent skill

Teaches coding agents to use the CLI.

```sh
hatch install-skill -g
```
