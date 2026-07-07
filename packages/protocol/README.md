# Hatch Protocol

Canonical provider-agnostic wire protocol for Hatch runtime sessions.

This package owns the JSON Schema for the server/local-harness boundary. The TypeScript runtime server and Rust local runner currently mirror this schema directly; generated TS and Rust types should be introduced from this package before the protocol is expanded further.

Current boundaries:

```text
server owns: sessions, history, LLM calls, skills, server tools
local runner owns: filesystem, shell, git, workspace containment
client sends: current user message and declared local workspace capability
server streams: assistant deltas, tool requests/results, approvals, turn state, final answer
```

Schema:

```text
schemas/hatch-wire-protocol.schema.json
```
