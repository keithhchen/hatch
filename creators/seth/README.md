# Seth Creator

Seth is registered as Creator `seth` with Agent `alpha-lite`. The initial
system prompt lives at `agent-corpus/instructions/system.md` and defines a
calm, evidence-first company-research assistant with explicit uncertainty
boundaries.

The Agent Corpus declares six Creator HTTP operations in
`agent-corpus/agent.json`. Their server-side connections and bindings are
listed in `control-plane-bindings.json`; this file is the Creator data seed,
including the plaintext API key used by the Control Plane connection.

The current API surface is company search, research pack, financial metrics,
company brief, official source route, and OpenAPI documentation.

The connections use `GET` and pass tool arguments as query parameters. The
Runtime's generic Creator HTTP executor supports this without exposing the
endpoint or API key to the Agent Corpus.
