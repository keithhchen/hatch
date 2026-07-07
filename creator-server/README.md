# Hatch Creator Skill Server

Minimal FastAPI Creator Skill Server for the Hatch MVP runtime channel.

## What It Implements

- `GET /healthz`
- `WS /runtime`
- accepts `runtime.hello`
- replies with `runtime.ready`
- accepts `turn.start`
- streams `agent.delta`
- calls a real OpenAI-compatible model runtime
- exposes `local_search` to the model as a tool
- proxies that tool through `tool.request` to the user's Local Runner
- accepts matching `tool.result`
- emits `turn.final`

Tests inject `FakeDeterministicRuntime`, but the runnable server requires
`OPENAI_API_KEY` and uses `OPENAI_BASE_URL` / `HATCH_CREATOR_MODEL`.

## Run Tests

```bash
cd creator-server
uv run --extra dev pytest
```

## Run The Server

```bash
cd creator-server
uv run hatch-creator-server
```

The development server listens on `127.0.0.1:8000` by default.
