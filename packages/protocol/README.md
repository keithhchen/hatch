# Hatch Protocol

Canonical provider-agnostic protocol 0.3, the **Agent Corpus** contract, and
the legacy Creator Release contract v1.

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
schemas/agent-corpus.schema.json
schemas/creator-release-public.schema.json
schemas/creator-release-private.schema.json
```

`agent-corpus.schema.json` defines the **Agent Corpus**: the complete,
publishable, provider-neutral body of one Creator Agent. It contains the
product contract, instructions, SKILL.md entrypoints, an agent-isolated
knowledge corpus, the declared Hatch/Creator tool requirements, and synthetic
QA/eval cases. It contains **no runtime configuration**: no model/provider,
deployment, stream setting, tool approval policy, server URL, credential, or
release/version field.

The Corpus declares `hatch.web_search` as a required Hatch capability. At
execution, Hatch supplies its implementation. Creator HTTP/MCP tools only name
a control-plane `connection_ref`; URLs, auth, approval policy, and the actual
connection live outside the Corpus.

At execution time the Runtime binds the Corpus to its own deployment: it maps
`hatch.web_search` to Hatch's search implementation, mounts the Corpus's
agent-scoped RAG namespace, resolves Creator connection refs through the
control plane, and chooses a model/runtime. Kimi 2.6 is currently that runtime
choice, but it is deliberately absent from the Corpus.

See [`AGENT_CORPUS.md`](./AGENT_CORPUS.md) for the fixed published-directory
layout and an exact separation between the Corpus and Runtime responsibilities.

The public Release schema is client-safe Registry/Desktop metadata. The private
schema is Runtime-only and contains the system prompt, protected Skill and RAG
asset references, selected few-shots, and runtime policy. Synthetic QA, Evals,
source traces, and other Factory/Creator-review artifacts remain outside the
Runtime Release. Both halves carry
the same immutable `release_id` and `sha256:` digest; private fields are never
valid wire-protocol payload fields.
