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
chat <product-id> <worker> <message...> [--wait]     history <product-id> <worker> [--after <id>]
stop <product-id> <worker>
assistant <message...> [--wait]          assistant history [--after <id>]
install-skill [-g] [--dir <skills-dir>]
mcp
```

Workers: `research`, `interview`, `builder`, `cases`, `evaluator`. `chat --wait` holds up to 60 s and prints the reply; without it, it prints the accepted message id. A worker whose dependencies have no output yet answers 409 with the reason.

Every command takes `--json`. `ingest` accepts links and files of any type (30 MB total); `--wait` polls every 5 s until the job finishes.

## Coding agents

Skill: `hatch install-skill` (to `./.agents/skills/hatch/`) or `hatch install-skill -g` (to `~/.agents/skills/hatch/`).

MCP (stdio, tools: whoami, products_list, products_show, products_create, products_update, products_unlist, ingest_submit, ingest_status, ingest_list, workers_list, worker_send, worker_history, worker_stop, assistant_send, assistant_history). Sign in first with `hatch login`; login, logout and keys stay human actions.

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
