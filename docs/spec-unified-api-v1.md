# Unified API v1: one HTTP API, CLI and MCP on top

Status: in progress (2026-11-07).

## Shape

- One HTTP API, served by Registry under `/v1`. Studio web, Desktop, the `hatch` CLI, its MCP mode and the Assistant are all clients of it.
- One identity: an ordinary Hatch account. Every request carries `Authorization: Bearer <token>`; every token is a row in `account_sessions`.
- Order of capability: sign in, sign out, manage products, then ingest into a product.

## Sign-in

| Client | How it gets a token | Standard |
|---|---|---|
| Studio web | Dashboard cookie session wrapping a Registry session | existing |
| Desktop | Browser sign-in, PKCE, `hatch://auth/callback` | existing (`creator-dashboard/desktopSignIn.mjs`) |
| CLI / coding agents | `hatch login`: same browser sign-in, PKCE, loopback redirect `http://127.0.0.1:<port>/callback` | RFC 8252 |
| Scripts, cloud jobs, webhooks | API key created in Studio or with `hatch keys create`, shown once, revocable | personal access token |
| Telegram etc. | Channel account link, the Assistant acts for the account | existing |

Native sign-in (Desktop and CLI share it):

1. The client opens `<web>/desktop/sign-in?state=<s>&code_challenge=<S256>&redirect_uri=<uri>&client=cli`.
2. The signed-in page `POST /v1/auth/desktop/authorize {state, code_challenge, redirect_uri}`; the server accepts `redirect_uri` only when it is the Desktop deep link or a loopback `http://127.0.0.1|localhost:<port>/callback`, binds it to the one-time code, and returns the redirect.
3. The client `POST /v1/auth/desktop/token {code, code_verifier, redirect_uri}` and receives `{token, expires_at}`.

Sessions carry `client_type`: `desktop`, `cli` or `api_key`. API keys: `POST /v1/auth/api-keys {name}` → `{id, name, token, created_at, expires_at}` (token returned once); `GET /v1/auth/api-keys`; `DELETE /v1/auth/api-keys/:id`. An API key cannot create API keys.

Sign out: `POST /v1/auth/logout` revokes the calling token. `GET /v1/auth/me` returns the account.

## Products

The existing `/v1/creator/products` routes are the product API: list/create (`GET|POST /v1/creator/products`), read/update/delete (`GET|PATCH|DELETE /v1/creator/products/:id`), `PUT .../listing` (unlisted), `POST .../withdraw`, `PUT .../brief-spec`, `PUT .../pricing`.

## Ingest

Per product. Anything goes in: links and files of any type.

- `POST /v1/creator/products/:id/ingest` with `{ items: [ {url} | {name, content_base64, media_type?} ], context? }` → `202 {job}`.
- `GET /v1/creator/products/:id/ingest/:job_id` → `{job}`; `GET /v1/creator/products/:id/ingest` lists recent jobs.
- `job = { id, product_id, status: queued|running|done|failed, items: [{ id, input, status: ok|partial|failed, markdown_path?, original_ref?, error? }], created_at, updated_at, error? }`.
- Plain text (`.md`, `.txt`) is stored as is. Everything else runs on the thick hosted agent (Kimi Hosted Agents, `runtime-server/src/hostedAgents/`): links are crawled with the account's browser profiles, files are converted, media is compressed and transcribed.
- Results: the Markdown goes to the product's shared `input/manual/` files (disk); the original goes to the object store (OSS) under the product's prefix and the item records its ref.

## CLI and MCP

`hatch` (`packages/hatch-cli`) wraps the HTTP API: `login [--api-key-stdin]`, `logout`, `whoami`, `keys create|list|revoke`, `products list|show|create|update|unlist|withdraw`, `ingest <product> <url-or-file>... [--wait]`, `ingest status <product> <job>`. Credentials live in `~/.config/hatch/credentials.json` (mode 0600), with `--profile`. `HATCH_API_KEY` overrides. `hatch mcp` serves the same operations as MCP tools over stdio. A bundled skill teaches coding agents to use the CLI.
