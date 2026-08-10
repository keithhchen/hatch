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
  "name": "file_read",
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

- `file_list`
- `file_search`
- `file_read`
- `file_write`
- `file_patch`
- `shell_exec`
- `git_diff`

Only these exact canonical names are accepted. The runner rejects aliases and
older dotted spellings rather than silently translating the security boundary.

On macOS, `shell_exec` runs `/bin/sh -c` under `/usr/bin/sandbox-exec` with a
deny-by-default Seatbelt profile. It canonicalizes the Workspace, grants
read/write access only to that subtree, leaves required system runtimes
read-only, denies network and ambient IPC (including Unix sockets, Keychain,
Apple Events, launchd, system account databases, and access to outside
processes), and clears the parent environment. It uses macOS `posix_spawn` with
`POSIX_SPAWN_CLOEXEC_DEFAULT`; only stdin/stdout/stderr are explicitly carried
into the child, so an unrelated file or connected socket already open in the
Desktop process does not become a shell capability.

`HOME` and `TMPDIR` point to a mode-0700, per-call directory under the
runner-owned macOS temporary root. The scratch parent is not granted to the
sandbox, preventing the command from moving or replacing the scratch root.
Cleanup restores traversal permissions on hostile nested directories, removes
the tree, and turns cleanup failure into a structured shell-sandbox failure.
The command can still explicitly copy temporary bytes into the Workspace;
that is an ordinary user-authorized Workspace write, not retained scratch.

Hatch performs best-effort display filtering of the canonical Workspace and
scratch paths in stdout/stderr, including direct, `file:` URL, common
percent/shell-escaped, hex, and base64 forms. This is not a secrecy boundary: a
program can split, transform, encrypt, or write a path into an allowed file in
arbitrarily many ways. Shell stdout/stderr are therefore treated as
user-authorized local-tool results that may be returned to the runtime; neither
this runner nor its callers should claim that a path can never leave the Mac.

If Seatbelt or its self-check is unavailable, shell execution fails closed;
there is no unsafe host-shell fallback. Non-macOS builds likewise reject only
`shell_exec` with `shell_sandbox_unavailable`; typed filesystem tools remain
available. An App-Sandboxed host must arrange for the shell execution process
itself to resolve the Workspace bookmark. A dynamic PowerBox grant activated
only in the parent process is not inherited by a spawned shell.

Shell execution starts in a dedicated process group. The Seatbelt policy denies
new sessions and process groups by filtering `setsid(2)`, `setpgid(2)`, and
nested `posix_spawn(2)` (whose attributes can otherwise create a group without
either syscall). Child programs that use ordinary fork/exec remain available;
programs that require nested `posix_spawn` fail closed. macOS red-team tests
exercise all three escape paths with real executables. A separate inert group
anchor remains alive while the sandbox runs, so cancellation can always signal
the group even after the command's root shell exits. On completion, timeout, or
cancellation the runner sends `SIGKILL`, waits for the root and anchor, and
refuses to return until the group is gone. This lifecycle statement is scoped
to the macOS policy actually validated by those tests; it does not promise
recovery from a hypothetical OS sandbox bug that bypassed syscall filtering.
The result contains `stdout`, `stderr`, `exit_code`, `timed_out`, and truncation
flags. Both pipes are continuously drained and the returned stdout/stderr
combined are capped at 1 MiB. `file_read`
rejects ordinary files larger than 1 MiB and rejects XLSX files whose rendered
text exceeds 1 MiB with `file_too_large`; it never silently truncates file
content. The serialized local `tool_call.result` envelope is capped at 4 MiB.
The Cloud WSS transport can remain at its separately negotiated 8 MiB limit,
leaving room for JSON and protocol overhead. `git_diff` runs `git diff -- <path>`
inside the sandbox after validating the path stays in the sandbox.

Filesystem confinement is path-based, not inode isolation. An existing
hardlink inside a user-selected Workspace is part of the content the user chose
to expose. Writing that name changes the shared inode and is observable through
any outside hardlink name, even though the runner cannot discover or open that
outside name. Do not describe hardlinks as providing path-isolated copies.

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
  --request '{"type":"tool_call.request","run_id":"run_1","tool_call_id":"call_1","name":"file_read","arguments":{"path":"notes/lorem.txt"},"approval":"auto"}'
cargo run -- --sandbox /tmp/hatch-app tool-call \
  --request '{"type":"tool_call.request","run_id":"run_1","tool_call_id":"call_2","name":"shell_exec","arguments":{"command":"pwd","timeout_ms":30000},"approval":"auto"}'
cargo run -- --sandbox /tmp/hatch-app serve
```

## Tests

```sh
cargo test --manifest-path local-runner/Cargo.toml
```
