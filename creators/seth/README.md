# Seth Creator

Seth is registered as Creator `seth` with Agent `alpha-lite`. The initial
system prompt lives at `agent-corpus/instructions/system.md` and defines a
calm, evidence-first company-research assistant with explicit uncertainty
boundaries.

The Agent Corpus declares eight Creator HTTP operations in
`agent-corpus/agent.json`. Their server-side connections and bindings are
listed in `control-plane-bindings.json`; this file is a deployment seed, not a
credential store. The actual API key must be available to Runtime as
`SETH_ALPHA_LITE_API_KEY` and is referenced as
`env:SETH_ALPHA_LITE_API_KEY`.

The connections use `GET` and pass tool arguments as query parameters. The
Runtime's generic Creator HTTP executor supports this without exposing the
endpoint or API key to the Agent Corpus.
