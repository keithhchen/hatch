---
name: hatch
description: Use the `hatch` CLI (or its MCP tools) to manage Hatch products, ingest links and files into a product, and talk to a product's workers and the Assistant. Use when the user asks to create, list, update, unlist or withdraw a Hatch product, to feed URLs, documents, audio or video into a product's knowledge, or to ask a worker (research, interview, builder, cases, evaluator) or the Assistant to do something.
---

# Hatch

`hatch` is the command line for the Hatch API. You act as the signed-in human's account, so be careful and honest.

## Rules

1. Run `hatch whoami --json` first. If it fails with "Not signed in", stop and ask the human to run `hatch login` themselves in their own terminal. Never ask for or handle their password. Never paste, echo or store API keys in chat; if a key is needed, the human runs `hatch login --api-key-stdin` themselves.
2. Run `hatch products list --json` before acting, and use the real product id from it. Do not guess ids.
3. Always pass `--json` and parse the output. Errors go to stderr as `{"error": {...}}` with a non-zero exit code.
4. Ingest takes a product id plus links and/or files: `hatch ingest <product-id> <url-or-file>... --json --wait`. Total file size is capped at 30 MB per call; split larger sets. Use `--context "<why these sources>"` when it helps.
5. `--wait` polls every 5 seconds until the job is `done` or `failed`. Without it, use `hatch ingest status <product-id> <job-id> --json`.
6. Report job results honestly: per item `ok`, `partial` or `failed`, with the error text. Never call a `partial` or `failed` ingest a success. Do not retry blindly; tell the human what failed.
7. `unlist` and `withdraw` change what customers can see or buy. Do them only when the human asked for exactly that, and say which product you changed.
8. `login`, `logout` and `keys` are human actions. Do not run them.
9. Workers are conversations: `hatch workers <product-id> --json` lists them (`research`, `interview`, `builder`, `cases`, `evaluator`) with `availability` and `status`. Send with `hatch chat <product-id> <worker> "<message>" --wait --json`; the reply is in `reply.text`. If `status` is still `running` after `--wait`, read later with `hatch history <product-id> <worker> --json` (use `--after <message-id>` for only what is new); do not send the same message again. A message to a running worker joins its turn (`queued: true`). `hatch stop <product-id> <worker>` stops it.
10. A locked worker answers 409 `worker_unavailable` naming the workers that must produce output first. Report that; do not work around it. A worker acts on the human's product with their account, so send what the human asked for, not more. `hatch assistant "<message>" --wait` talks to the human's own Assistant, which may act on their behalf: say what you asked it.

If the `hatch` MCP server is configured, use its tools instead of the CLI: `whoami`, `products_list`, `products_show`, `products_create`, `products_update`, `products_unlist`, `ingest_submit`, `ingest_status`, `ingest_list`, `workers_list`, `worker_send` (set `wait` to 60 to get the reply), `worker_history`, `worker_stop`, `assistant_send`, `assistant_history`. The same rules apply; `ingest_submit` returns a job, so poll `ingest_status` until it is `done` or `failed`.

See `references/commands.md` for every command and its output.
