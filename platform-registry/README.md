# Hatch Platform Registry

FastAPI service for the single current, runnable `Agent Corpus` belonging to
each `creator_id + agent_id`. The Registry never stores Factory drafts, raw
course material, distillation traces, runtime state, or tool credentials.

## API

- `GET /health`
- `POST /v1/agent-corpora` — internal Factory publish
- `GET /v1/creators/{creator_id}/agent-corpora`
- `GET /v1/creators/{creator_id}/agent-corpora/{agent_id}`
- `PUT /v1/control-plane/connections/{connection_id}`
- `PUT /v1/creators/{creator_id}/agents/{agent_id}/tools/{tool_id}`
- `GET /v1/runtime/creators/{creator_id}/agents/{agent_id}/tools/{tool_id}`

Factory publishes a fully validated Corpus from the shared POSIX host. The
Registry promotes it to its creator/agent path and replaces the prior current
Corpus for that identity. The Runtime then materializes the same package by
`creator_id + agent_id`. Retired `knowledge` and `hatch.file_search` entries in
older `agent.json` files are ignored.

Creator HTTP/MCP tool declarations live in the Corpus as a `connection_ref`
plus allowed operation/tool name. URLs and `secret_ref`s live in the Control Plane;
actual credentials are resolved only by Runtime secret management.

## Local development

```bash
uv sync --extra dev
uv run pytest -q tests/test_agent_corpus_registry.py
HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN=replace-with-an-internal-secret \
  uv run uvicorn hatch_registry.app:app --reload
```
