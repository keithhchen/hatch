# Hatch Local Runner

This package is the MVP Rust core and CLI skeleton for Hatch's desktop Local Runner.
It implements a confined local filesystem tool surface, accepts Hatch canonical
`tool_call.request` JSON, returns `tool_call.result` JSON, and writes one JSON
audit event per tool call to `audit.jsonl` in the sandbox root.

## Tools

All tool paths are relative to `--sandbox`. Absolute paths, `..` escapes, and paths
that resolve through symlinks outside the sandbox are rejected.

Implemented tools:

- `list [path]`
- `stat <path>`
- `search <query> [path]`
- `read <path>`
- `write-file <path> --content <text>`
- `append-file <path> --content <text>`
- `copy <src> <dst> [--overwrite]`
- `move <src> <dst> [--overwrite]`
- `apply-patch <path> --patch <patch-text>`
- `tool-call --request <json>`
- `serve`

`copy` is intentionally file-only in this MVP. `move` can move files or
directories inside the sandbox.

## Hatch Tool Protocol

The production local executor should not do agent thinking. It only executes
server-issued deterministic local tool calls. The current supported protocol
surface is:

```json
{
  "type": "tool_call.request",
  "run_id": "run_123",
  "tool_call_id": "call_123",
  "name": "fs.read",
  "arguments": {
    "path": "src/app.ts"
  },
  "approval": "auto"
}
```

Successful output:

```json
{
  "type": "tool_call.result",
  "run_id": "run_123",
  "tool_call_id": "call_123",
  "status": "ok",
  "result": {
    "content": "..."
  }
}
```

Failure output:

```json
{
  "type": "tool_call.result",
  "run_id": "run_123",
  "tool_call_id": "call_123",
  "status": "error",
  "error": {
    "code": "tool_failed",
    "message": "path escapes sandbox: ../secret.txt"
  }
}
```

Supported canonical local tools today:

- `fs.list`
- `fs.search`
- `fs.read`
- `fs.write`
- `fs.patch`
- `shell.exec`
- `git.diff`

`shell.exec` runs `sh -lc` inside the sandbox root, kills the process after
`timeout_ms`, and returns `stdout`, `stderr`, `exit_code`, `timed_out`, and
truncation flags. Both pipes are continuously drained, each retains at most
1 MiB, and the returned stdout/stderr combined are capped at 1 MiB. `fs.read`
rejects ordinary files larger than 1 MiB and rejects XLSX files whose rendered
text exceeds 1 MiB with `file_too_large`; it never silently truncates file
content. The serialized local `tool_call.result` envelope is capped at 4 MiB.
The Cloud WSS transport can remain at its separately negotiated 8 MiB limit,
leaving room for JSON and protocol overhead. `git.diff` runs `git diff -- <path>`
inside the sandbox after validating the path stays in the sandbox.

For a long-lived Tauri or CLI sidecar, run `serve`. It reads newline-delimited
JSON `tool_call.request` messages from stdin and writes one newline-delimited
JSON response to stdout for each request. This process is intentionally
stateless beyond the sandbox and audit log; session history, skill loading,
policy decisions, and LLM calls stay on the TypeScript server.

## Patch Format

`apply-patch` accepts a small Hatch patch format. It does not execute shell
commands and only changes the target file.

Append:

```text
HATCH-PATCH v1
append
---
Lorem ipsum from Person A.
```

Replace exactly one occurrence:

```text
HATCH-PATCH v1
replace
--- old
Person A
--- new
Person B
```

Replacement patches fail when the old text is absent or appears more than once.

## CLI Examples

```sh
cargo run -- --sandbox /tmp/hatch-app list .
cargo run -- --sandbox /tmp/hatch-app write-file notes/lorem.txt \
  --content "Lorem ipsum for Person A."
cargo run -- --sandbox /tmp/hatch-app search "Person A" .
cargo run -- --sandbox /tmp/hatch-app read notes/lorem.txt
cargo run -- --sandbox /tmp/hatch-app tool-call \
  --request '{"type":"tool_call.request","run_id":"run_1","tool_call_id":"call_1","name":"fs.read","arguments":{"path":"notes/lorem.txt"},"approval":"auto"}'
cargo run -- --sandbox /tmp/hatch-app tool-call \
  --request '{"type":"tool_call.request","run_id":"run_1","tool_call_id":"call_2","name":"shell.exec","arguments":{"command":"pwd","timeout_ms":30000},"approval":"auto"}'
cargo run -- --sandbox /tmp/hatch-app serve
```

## Tests

```sh
cargo test --manifest-path local-runner/Cargo.toml
```
