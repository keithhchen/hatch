# Hatch Protocol

Canonical provider-agnostic protocol 0.3, the current Creator Agent contract,
and the legacy Creator Release contract v1.

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
schemas/creator-agent.schema.json
schemas/creator-release-public.schema.json
schemas/creator-release-private.schema.json
```

`creator-agent.schema.json` is the target server-private definition of a full
Creator Agent: product contract, instructions, SKILL.md entrypoints, one
tenant-and-agent-isolated RAG vector store, the merged Hatch/Creator tool list,
synthetic QA and eval cases, and a Kimi runtime profile. It deliberately has no
agent release/version field. `hatch.web_search` is required and is configured by
Hatch at runtime; credentials for Creator HTTP/MCP connections are referenced
through the control plane, never embedded in the Agent document.

At execution time the Runtime projects this provider-neutral document onto the
OpenAI Responses tool model: `hatch.web_search` becomes `web_search`, the
single agent-scoped vector store becomes `file_search` with one
`vector_store_id`, a Creator HTTP operation becomes a strict `function`, and a
Creator MCP entry becomes a native `mcp` tool with `server_label`, `server_url`,
and an allowlist. The model profile is currently fixed to Kimi 2.6; the document
does not carry a provider credential.

The public Release schema is client-safe Registry/Desktop metadata. The private
schema is Runtime-only and contains the system prompt, protected Skill and RAG
asset references, selected few-shots, and runtime policy. Synthetic QA, Evals,
source traces, and other Factory/Creator-review artifacts remain outside the
Runtime Release. Both halves carry
the same immutable `release_id` and `sha256:` digest; private fields are never
valid wire-protocol payload fields.
