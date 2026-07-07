# Hatch Platform Registry

Minimal FastAPI service for the Hatch Registry MVP. The service is metadata-only and uses in-memory storage seeded with a synthetic `app_a` manifest.

## API

- `GET /health`
- `GET /v1/manifests`
- `GET /v1/manifests/{app_id}`
- `GET /v1/apps/{app_id}/latest`
- `POST /v1/installs`
- `POST /v1/licenses/verify`

## Local Development

```bash
uv sync --extra dev
uv run pytest
uv run uvicorn hatch_registry.app:app --reload
```

The manifest signature uses a deterministic development Ed25519 key. It is a placeholder for future production signing and key rotation.
