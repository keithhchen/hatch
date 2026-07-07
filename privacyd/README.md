# privacyd

`privacyd` is the local Hatch privacy sidecar MVP. It provides:

- deterministic PII and secret scanning,
- stable per-app pseudonym mapping,
- outbound text sanitization,
- a FastAPI `/sanitize` endpoint.

The OpenAI Privacy Filter integration is an optional adapter boundary. Tests use the deterministic scanner and a null adapter only.

## Run Tests

```bash
cd privacyd
uv run --extra test pytest
```

## Run Service

```bash
cd privacyd
uv run privacyd
```

The service binds to `127.0.0.1:8765` by default.
