# Hatch Protocol

Canonical provider-agnostic wire protocol 0.3 and Agent Corpus v1.

This package owns the JSON Schema for the server/Desktop local-client boundary. The TypeScript runtime server and Rust local runner currently mirror this schema directly; generated TS and Rust types should be introduced from this package before the protocol is expanded further.

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
schemas/creator-agent.schema.json
```

## Agent Corpus v1

`creator-agent.schema.json` is the self-contained public canonical schema for
`agent-corpus.schema.json`. It describes one current, publishable Creator
Agent. The Corpus is deliberately runtime-free: it contains the Agent's
product identity and description, global instructions, optional local Skills,
retrieval-only knowledge, declarative tools, and non-runtime evaluation assets. It contains
no model/provider choice, vector-store ID, endpoint, credential, raw Creator
material, Factory trace, or version history.

The files referenced by a Corpus have four different jobs. They are not
interchangeable:

```text
instructions/system.md             Global worldview, voice, values, product boundaries,
                                   and global canonical few-shots. Always loaded.

skills/<skill-id>/SKILL.md         One optional, independently reusable local execution
                                   unit. Loaded only when that unit is needed.

skills/<skill-id>/references/*.md  Local method, style, or example material for that
                                   Skill only. Never a RAG document.

knowledge/*.md                     Long-tail material to retrieve only when needed.
                                   Never global instruction, Skill instruction/reference,
                                   canonical few-shot, or evaluation.

evals/*.json                       Synthetic QA and held-out validation only. Never
                                   automatic Runtime context.
```

An Agent may legitimately have no Skills: omit `skills` or use `[]`. A Skill
is not the entire delivery workflow. It exists only when a local execution
unit is independently reusable and needs its own instruction, method,
reference, or scoped tool permission. Global rules belong in `system.md`;
rules that matter only while performing one local unit belong in that Skill or
its references; long-tail evidence belongs in `knowledge/`.

Synthetic QA is a Factory input to this placement decision. A high-frequency
example which changes global behavior is distilled into `system.md`; a local
example belongs with the relevant Skill reference; broad fallback material may
become retrieval knowledge. The retained `evals/` assets are for validation,
not an instruction channel.

`tools` is declarative. `hatch.web_search` is mandatory for every Agent.
`hatch.local.*` declares a Desktop local capability. `creator.*` HTTP
and MCP tools carry only a `connection_ref` plus the allowed operation or tool;
their endpoints and credentials live in Hatch Control Plane, outside the
Corpus.

At publish time Registry binds one `creator_id + agent_id` to its own isolated
knowledge space. A Runtime turns that binding into `hatch.file_search`; neither
the Corpus nor the Desktop carries a knowledge-base/vector-store identifier.

Registry publishes exactly one current Corpus per `creator_id + agent_id` and
records its computed `corpus_digest`. Runtime loads protected instructions and
assets directly from that installed Corpus. Desktop receives only product
metadata, the Agent identity, the current digest, and runtime events; it never
receives protected Corpus files.
