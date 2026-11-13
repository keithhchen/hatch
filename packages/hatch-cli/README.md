# hatch CLI

Command line, coding-agent skill and MCP server for the Hatch unified API (`docs/spec-unified-api-v1.md`). Node >= 20, no dependencies.

## Install

```sh
npm install -g https://gethatchapp.com/downloads/hatch-cli.tgz   # Node 20+
hatch --help
```

## Sign in

```sh
hatch login                         # asks: browser sign-in or paste an API key
echo "$KEY" | hatch login --api-key-stdin   # store an API key instead
hatch whoami
hatch logout
```

Credentials: `~/.config/hatch/credentials.json` (0600), per `--profile`. `HATCH_API_KEY` overrides them. `HATCH_API_URL` / `HATCH_WEB_URL` default to `https://gethatchapp.com`. Tokens are never printed.

## Commands

```
login [--browser|--api-key-stdin]     logout     whoami
keys create <name> | list | revoke <id>
products list | show <id> | create --name <n> [--promise <p>] | update <id> [--name] [--promise]
         | unlist <id> [--off] | withdraw <id>
ingest <product-id> <url-or-file>... [--context <text>] [--wait]
ingest status <product-id> <job-id>      ingest list <product-id>
workers <product-id>
chat <product-id> <worker> <message...> [--wait[=N]] [--stream] [--key <id>]     history <product-id> <worker> [--after <id>]
stop <product-id> <worker>
assistant <message...> [--wait[=N]] [--stream] [--key <id>]     assistant history [--after <id>]
conversations --product <id> [--cursor <next_cursor>]     list your Chat conversations with a product
ask <message...> --product <id> [--conversation <id>] [--wait[=N]] [--stream] [--key <id>]
conversation show <id> | watch <id> [--after <cursor>] | stop <id> <run-id>      (each needs --product <id>)
install-skill [-g] [--dir <skills-dir>]
mcp
```

Workers: `research`, `interview`, `builder`, `cases`, `evaluator`. `chat --wait` holds up to 60 s and prints the reply; without it, it prints the accepted message id. A worker whose dependencies have no output yet answers 409 with the reason.

Chat (`ask`, `conversation ...`) is consumer Chat with a published Product, separate from the Studio workers. The Runtime binds every Chat call to a Product, so every command takes `--product`. `ask` without `--conversation` starts a conversation and prints its `conversation_id`; with it, continues one. Every send carries a `client_message_id` (`--key` to choose it; the JSON result returns it): pass the same key to retry a send without sending it twice. `--stream` prints the reply as it arrives and, if the connection drops, reconnects with `after_cursor` set to the last journal cursor (live text deltas carry no cursor and are not replayed, so read the full reply with `conversation show`); if it gives up it prints the cursor for `conversation watch <id> --after <cursor>`. The Run belongs to the server: closing the CLI never stops it, only `conversation stop` does. Browser login and API keys both work for all of these.

Every command takes `--json`. `ingest` accepts links and files of any type (50 MB per file, uploaded straight to storage); `--wait` polls every 5 s until the job finishes.

## Coding agents

Skill: `hatch install-skill` (to `./.agents/skills/hatch/`) or `hatch install-skill -g` (to `~/.agents/skills/hatch/`).

MCP (stdio, tools: whoami, products_list, products_show, products_create, products_update, products_unlist, ingest_submit, ingest_status, ingest_list, workers_list, worker_send, worker_history, worker_stop, assistant_send, assistant_history, conversations_list, chat_send, conversation_show, chat_stop). Sign in first with `hatch login`; login, logout and keys stay human actions.

```sh
claude mcp add hatch -- hatch mcp
```

```toml
# ~/.codex/config.toml
[mcp_servers.hatch]
command = "hatch"
args = ["mcp"]
```

## Tests

```sh
node --test
```
