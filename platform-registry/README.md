# Hatch Platform Registry

FastAPI service for the single current, runnable `Agent Corpus` belonging to
each `tenant_id + agent_id`. The Registry never stores Factory drafts, raw
course material, distillation traces, runtime state, or tool credentials.

## API

- `GET /health`
- `POST /v1/agent-corpora` — internal Factory publish
- `GET /v1/tenants/{tenant_id}/agent-corpora`
- `GET /v1/tenants/{tenant_id}/agent-corpora/{agent_id}`
- `POST /v1/runtime/tenants/{tenant_id}/agents/{agent_id}/knowledge/search`
- `PUT /v1/control-plane/connections/{connection_id}`
- `PUT /v1/tenants/{tenant_id}/agents/{agent_id}/tools/{tool_id}`
- `GET /v1/runtime/tenants/{tenant_id}/agents/{agent_id}/tools/{tool_id}`

Factory publishes a fully validated Corpus from the shared POSIX host. The
Registry first uploads `knowledge.documents` to one isolated Bailian namespace,
waits until it is indexed, and only then promotes the Corpus to its
tenant/agent path and replaces the prior current Corpus for that identity. It
does not chunk, embed, or locally index knowledge text. The Runtime then
materializes the same package by `tenant_id + agent_id`.

Creator HTTP/MCP tool declarations live in the Corpus as a `connection_ref`
plus allowed operation/tool name. URLs and `secret_ref`s live in the Control Plane;
actual credentials are resolved only by Runtime secret management.

The Runtime-only knowledge endpoint takes `{ "query": "…",
"max_num_results": 5 }` and returns `{ "data": [{ "text": "…",
"metadata": {}, "score": 0.0 }] }`. It is authenticated with the same
internal service token and tenant header as other runtime endpoints. The
Registry looks up its private, agent-scoped managed-RAG binding; neither
`IndexId` nor Bailian credentials enter the Runtime or the Corpus.

## Local development

```bash
uv sync --extra dev
uv run pytest -q tests/test_agent_corpus_registry.py
HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN=replace-with-an-internal-secret \
  uv run uvicorn hatch_registry.app:app --reload
```

## Production RAG configuration

The Registry process—not Factory, Runtime, Desktop, or the Corpus—must receive
these environment variables:

```bash
HATCH_BAILIAN_WORKSPACE_ID=llm-...
# Production on ECS: the attached RAM Role supplies and refreshes STS.
# No AccessKey variables are needed there.
# Local development outside ECS only:
ALIBABA_CLOUD_ACCESS_KEY_ID=...
ALIBABA_CLOUD_ACCESS_KEY_SECRET=...
HATCH_BAILIAN_RAG_STATE_PATH=/var/lib/hatch/bailian-rag-state.json
```

The RAM principal needs Model Studio knowledge-base permissions (the
`AliyunBailianDataFullAccess` policy includes them) and membership in that
workspace. The private state file maps only `tenant_id/agent_id` namespaces to
Bailian IndexIds; it is Control Plane state, never part of a Corpus or Runtime
configuration. If those variables are absent, publishing a Corpus that has
knowledge documents fails closed rather than silently using a local lexical
index.
