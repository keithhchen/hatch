# Hatch Protocol

Canonical provider-agnostic protocol 0.3 and Creator Release contract v1.

This package owns the JSON Schema for the server/local-harness boundary. The TypeScript runtime server and Rust local runner currently mirror this schema directly; generated TS and Rust types should be introduced from this package before the protocol is expanded further.

Current boundaries:

```text
server owns: sessions, history, LLM calls, skills, server tools
local runner owns: filesystem, shell, git, workspace containment
client sends: current user message and declared local workspace capability
server streams: assistant deltas, tool requests/results, turn state, final answer
```

Schema:

```text
schemas/hatch-wire-protocol.schema.json
schemas/creator-release-public.schema.json
schemas/creator-release-private.schema.json
```

The public Release schema is client-safe Registry/Desktop metadata. The private
schema is Runtime-only and contains the system prompt, protected Skill and RAG
asset references, selected few-shots, and runtime policy. Synthetic QA, Evals,
source traces, and other Factory/Creator-review artifacts remain outside the
Runtime Release. Both halves carry
the same immutable `release_id` and `sha256:` digest; private fields are never
valid wire-protocol payload fields.
