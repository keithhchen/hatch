# hatch commands

Global: `--json` raw JSON, `--profile <name>` (default `default`), `--help`. Env: `HATCH_API_URL`, `HATCH_WEB_URL`, `HATCH_API_KEY` (overrides stored credentials).

| Command | What it does |
|---|---|
| `whoami` | Account for the active credentials. Fails with "run `hatch login`" when not signed in. |
| `products list` | `[{product_id, name, status, ...}]` |
| `products show <id>` | One product including `promise`. |
| `products create --name <n> [--promise <p>]` | Creates a draft. Promise defaults to the name. |
| `products update <id> [--name <n>] [--promise <p>]` | Merges onto the current product. |
| `products unlist <id> [--off]` | Hides from public listings; `--off` lists it again. |
| `products withdraw <id>` | Stops new access to a published product. |
| `ingest <product-id> <url-or-file>... [--context <text>] [--wait]` | Submits links (http/https) and files (any type, 30 MB total). Returns the job. |
| `ingest status <product-id> <job-id>` | Current job. |
| `ingest list <product-id>` | Recent jobs. |
| `install-skill [-g] [--dir <skills-dir>]` | Installs this skill. |

Human-only: `login [--api-key-stdin]`, `logout`, `keys create|list|revoke`.

## Job shape

```json
{ "id": "...", "product_id": "...", "status": "queued|running|done|failed",
  "items": [{ "id": "...", "input": "...", "status": "ok|partial|failed", "markdown_path": "...", "original_ref": "...", "error": "..." }],
  "error": "..." }
```

Plain text (`.md`, `.txt`) is stored as is. Other files and links are converted to Markdown by the hosted agent, which can take minutes. Results land in the product's `input/manual/` files.

Exit codes: 0 ok, 1 error or a failed job, 2 usage error.
