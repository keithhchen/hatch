# Technical Stack

Status: stack proposal v0.1

This document defines the implementation stack for:

```text
Desktop Local Runner
Creator Skill Server
Hatch Registry
Protocol Schemas
```

The guiding rule is:

> Use mainstream primitives where they matter, especially agent runtime and desktop system access. Do not invent framework layers where mature infrastructure exists.

## 1. Repository Shape

Recommended monorepo:

```text
hatch/
  local-runner/          # Tauri desktop app
  privacyd/              # local Python privacy sidecar
  creator-server/        # creator runtime built on OpenAI Agents SDK
  platform-registry/     # metadata, manifests, license, billing
  protocol/              # JSON schemas and shared examples
  examples/              # synthetic demo apps
  docs/
```

Package managers:

```text
Rust: cargo
TypeScript: pnpm
Python: uv
```

No heavy monorepo framework in v0.1. A `justfile` or `make` targets are enough.

## 2. Language Choices

| Component | Language | Why |
| --- | --- | --- |
| Local Runner native core | Rust | Filesystem safety, Tauri, native packaging, async networking, strong sandbox boundary |
| Local Runner UI | TypeScript + React | Fast product UI, type-safe protocol handling, mature desktop webview stack |
| Privacy sidecar | Python | OpenAI Privacy Filter is Python/PyTorch-first |
| Creator Skill Server | Python | OpenAI Agents SDK is Python-first and mature |
| Hatch Registry | Python | Same backend stack as Creator Server; faster shared auth/license/manifest work |
| Protocol schemas | JSON Schema + generated/handwritten bindings | Neutral across Rust, Python, and TypeScript |

## 3. Desktop Local Runner

### 3.1 Stack

```text
Tauri 2
React
TypeScript
Vite
Rust async core
SQLite local state
WebSocket runtime client
```

Use a desktop app, not PWA. Local filesystem, local model sidecar, file watching, keychain access, and background indexing are core product features.

The Local Runner should be **Rust-first**. React is a presentation layer, not the owner of filesystem or privacy-critical behavior.

```text
React/TypeScript:
  chat UI
  workspace panel
  audit log rendering
  install/settings screens

Rust core:
  filesystem sandbox
  file watcher/indexer
  local search
  patch/write/copy/move engine
  encrypted local state
  OS keychain integration
  WebSocket runtime client
  audit event writer

Python privacyd:
  OpenAI Privacy Filter
  PII span detection
  model-backed privacy checks
```

Do not implement path containment, local search, patch application, entity-map encryption, or creator-facing local tool execution in frontend JavaScript.

### 3.2 TypeScript Dependencies

Core:

```json
{
  "@tauri-apps/api": "latest stable",
  "@tauri-apps/plugin-dialog": "latest stable",
  "@tauri-apps/plugin-log": "latest stable",
  "@tauri-apps/plugin-opener": "latest stable",
  "@tauri-apps/plugin-updater": "latest stable",
  "react": "latest stable",
  "react-dom": "latest stable",
  "vite": "latest stable",
  "typescript": "latest stable",
  "zod": "latest stable",
  "zustand": "latest stable",
  "@tanstack/react-query": "latest stable"
}
```

Optional UI layer:

```json
{
  "tailwindcss": "latest stable",
  "lucide-react": "latest stable",
  "clsx": "latest stable"
}
```

Rationale:

- `zod` validates protocol payloads before they reach UI state.
- `zustand` is enough for local app state; no Redux.
- `react-query` handles control-plane HTTP calls: manifests, licenses, updates.
- Tauri plugins are kept narrow: dialog, log, opener, updater. Filesystem access should mostly go through Rust commands, not arbitrary frontend FS APIs.

### 3.3 Rust Dependencies

Core runtime:

```toml
tauri = "latest stable"
tokio = "latest stable"
serde = "latest stable"
serde_json = "latest stable"
thiserror = "latest stable"
anyhow = "latest stable"
uuid = "latest stable"
time = "latest stable"
tracing = "latest stable"
tracing-subscriber = "latest stable"
```

Filesystem and indexing:

```toml
ignore = "latest stable"
notify = "latest stable"
walkdir = "latest stable"
blake3 = "latest stable"
grep-searcher = "latest stable"
grep-regex = "latest stable"
diffy = "latest stable"
```

Networking:

```toml
reqwest = "latest stable"
tokio-tungstenite = "latest stable"
futures-util = "latest stable"
url = "latest stable"
```

Local state and crypto:

```toml
rusqlite = "latest stable"
keyring = "latest stable"
chacha20poly1305 = "latest stable"
hkdf = "latest stable"
rand = "latest stable"
base64 = "latest stable"
```

Manifest/license verification:

```toml
ed25519-dalek = "latest stable"
jsonwebtoken = "latest stable"
semver = "latest stable"
```

Rationale:

- `ignore` and `walkdir` provide predictable workspace traversal.
- `notify` powers background indexing.
- `grep-searcher` gives ripgrep-like local search without shelling out.
- `diffy` handles patch-style edits without exposing shell.
- `rusqlite` is simpler than a DB server and works well in a desktop app.
- Sensitive values are encrypted at the field level with a key stored in OS keychain. This avoids forcing SQLCipher into the first cross-platform build while still protecting entity values.

### 3.4 Local State Storage

Use SQLite for structured local runtime state:

```text
installed apps
license cache
conversation map
entity map metadata
file hash cache
privacy scan cache
workspace index
tool audit index
```

Sensitive values should be encrypted before insertion:

```text
encrypted entity values
encrypted aliases
encrypted local refs where needed
```

Use:

```text
OS keychain -> root key
HKDF -> per-app encryption keys
XChaCha20-Poly1305 or ChaCha20-Poly1305 -> field encryption
HMAC(per_app_salt, normalized_value) -> canonical_hash
```

SQLCipher can be added later if full database encryption becomes required, but v0.1 should not block on cross-platform SQLCipher packaging.

## 4. privacyd

`privacyd` is a local sidecar process called by the Local Runner.

### 4.1 Stack

```text
Python 3.12
OpenAI Privacy Filter
PyTorch
FastAPI or stdio JSON-RPC
```

OpenAI Privacy Filter currently requires Python 3.10+, so Python 3.12 is a safe target.

### 4.2 Python Dependencies

Core:

```toml
opf = { source = "openai/privacy-filter package or local wheel" }
torch = "*"
safetensors = "*"
tiktoken = "*"
huggingface_hub = "*"
numpy = "*"
packaging = "*"
pydantic = "*"
```

Local service:

```toml
fastapi = "*"
uvicorn = { extras = ["standard"] }
httpx = "*"
```

Deterministic scanner:

```toml
regex = "*"
phonenumbers = "*"
```

Testing:

```toml
pytest = "*"
pytest-asyncio = "*"
```

Rationale:

- `opf` is the local OpenAI Privacy Filter package.
- `torch`, `safetensors`, `tiktoken`, `huggingface_hub`, and `numpy` are part of the model runtime stack.
- `phonenumbers` catches phone formats more reliably than regex alone.
- `regex` is better than Python's standard `re` for some Unicode and advanced matching cases.

### 4.3 Packaging

Development:

```text
uv run privacyd
```

Production:

```text
bundle privacyd as a sidecar executable
download model weights on first run
verify checksum/signature
cache under LocalRunnerData/models/
```

Do not bundle huge model weights inside the first desktop installer unless product distribution needs offline install.

### 4.4 Privacy Pipeline

```text
raw text
-> deterministic scan
-> OpenAI Privacy Filter span detection
-> merge spans
-> entity resolver
-> stable pseudonym replacement
-> sanitized text
```

The PII model finds spans. The Local Runner's entity map gives continuity.

## 5. Creator Skill Server

The Creator Skill Server owns the private skill logic and LLM runtime.

### 5.1 Stack

```text
Python 3.12
FastAPI
OpenAI Agents SDK
WebSocket runtime endpoint
Postgres for creator metadata/session pointers
Redis optional for multi-worker run coordination
```

### 5.2 Python Dependencies

Core:

```toml
openai-agents = "*"
fastapi = "*"
uvicorn = { extras = ["standard"] }
pydantic = "*"
pydantic-settings = "*"
httpx = "*"
websockets = "*"
```

Persistence:

```toml
sqlalchemy = "*"
asyncpg = "*"
alembic = "*"
redis = { optional = true }
```

Auth/license:

```toml
pyjwt = "*"
cryptography = "*"
```

Observability:

```toml
structlog = "*"
opentelemetry-api = "*"
opentelemetry-sdk = "*"
opentelemetry-instrumentation-fastapi = "*"
```

Testing:

```toml
pytest = "*"
pytest-asyncio = "*"
pytest-httpx = "*"
```

Rationale:

- `openai-agents` is the core runtime. The server wraps it; it does not redefine agent semantics.
- FastAPI gives native WebSocket support and a simple HTTP control plane.
- Postgres stores app/server metadata, sanitized session pointers, license verification records, and creator config.
- Redis is not required for single-worker MVP, but useful once local tool requests may be routed across workers.

### 5.3 LocalToolBroker

The server exposes local tools to OpenAI Agents SDK as normal async tools.

Internally each local tool:

```text
serializes tool.request
sends it over the runner WebSocket
waits for tool.result
returns sanitized output to the Agents SDK tool call
```

This keeps OpenAI Agents SDK as the runtime primitive.

## 6. Hatch Registry

The Hatch Registry is metadata-only in v0.1.

### 6.1 Stack

```text
Python 3.12
FastAPI
Postgres
Stripe
Ed25519 manifest signing
JWT or PASETO-style license token
S3/R2 optional for static app assets
```

### 6.2 Python Dependencies

Core:

```toml
fastapi = "*"
uvicorn = { extras = ["standard"] }
pydantic = "*"
pydantic-settings = "*"
sqlalchemy = "*"
asyncpg = "*"
alembic = "*"
httpx = "*"
```

Auth, signing, billing:

```toml
cryptography = "*"
pyjwt = "*"
stripe = "*"
passlib = "*"
argon2-cffi = "*"
```

Object storage, optional:

```toml
boto3 = { optional = true }
```

Testing:

```toml
pytest = "*"
pytest-asyncio = "*"
pytest-httpx = "*"
```

Rationale:

- Hatch Registry should be boring infrastructure.
- It should not include agent runtime dependencies.
- It should not have any code path that accepts user workspace content.

## 7. Protocol Package

Protocol definitions should be neutral and implementation-independent.

Canonical source:

```text
protocol/schemas/*.schema.json
```

Schemas:

```text
manifest.schema.json
runtime-message.schema.json
local-tool.schema.json
audit-event.schema.json
license.schema.json
```

Bindings:

```text
Python: Pydantic models
TypeScript: Zod schemas or generated types
Rust: serde structs
```

Suggested dependencies:

```text
Python: pydantic, jsonschema
TypeScript: zod, json-schema-to-ts
Rust: schemars, serde
```

The protocol package should include synthetic examples only:

```text
PERSON_A
ORG_A
PROJECT_A
lorem ipsum
```

No real user data in examples, tests, fixtures, docs, or eval samples.

## 8. Infrastructure

### 8.1 Local Development

Use Docker Compose for server-side services:

```text
postgres
redis optional
platform-registry
creator-server
```

Local Runner and privacyd run directly on the developer machine.

### 8.2 Production

Hatch Registry:

```text
containerized FastAPI service
Postgres
Stripe
S3/R2 for public metadata assets
CDN for app icons/screenshots/manifests
```

Creator Skill Server:

```text
creator-hosted or platform-hosted container
OpenAI API key owned by creator
Postgres optional
Redis optional for multi-worker WebSocket coordination
```

Local Runner:

```text
signed desktop binary
auto-update channel
sidecar privacyd
model weight download/cache
```

## 9. Testing Stack

Local Runner:

```text
Rust: cargo test
TypeScript: vitest
UI: Playwright component/e2e where possible
Filesystem sandbox tests with temp directories
```

privacyd:

```text
pytest
golden synthetic PII fixtures
span merge tests
pseudonym stability tests
```

Creator Server:

```text
pytest-asyncio
mock Local Runner WebSocket
mock OpenAI Agents SDK tool calls where needed
contract tests for runtime messages
```

Hatch Registry:

```text
pytest
manifest signing tests
license verification tests
billing webhook tests with Stripe test payloads
```

Protocol:

```text
schema validation tests
cross-language fixture tests
no-real-data fixture lint
```

## 10. MVP Dependency Summary

Must-have for v0.1:

```text
Tauri
React
TypeScript
Rust async stack
SQLite
OS keychain
WebSocket client/server
OpenAI Privacy Filter
OpenAI Agents SDK
FastAPI
Postgres
Ed25519 signing
Stripe
JSON Schema
```

Do not add in v0.1 unless forced:

```text
Kubernetes
Kafka
Temporal
LangChain
LangGraph
custom vector database
SQLCipher hard requirement
platform full-content runtime
automatic eval telemetry
browser/PWA local filesystem path
```

## 11. Why This Stack Is Not Overbuilt

The heavy-looking parts map directly to product-critical risks:

```text
Tauri/Rust: local trust, filesystem, desktop distribution
privacyd/OpenAI Privacy Filter: local privacy boundary
OpenAI Agents SDK: creator runtime control without custom agent loop
WebSocket: native shape for streaming agent turns and local tools
Hatch Registry: commercial distribution and licensing
SQLite/keychain: stable local entity map and app state
```

The stack avoids complexity in the wrong places:

```text
no shell access
no platform content proxy
no automatic eval telemetry
no cross-app identity graph
no custom agent framework
no PWA filesystem workaround
```

## 12. References

- OpenAI Agents SDK package: https://pypi.org/project/openai-agents/
- OpenAI Agents SDK docs: https://openai.github.io/openai-agents-python/
- OpenAI Privacy Filter: https://github.com/openai/privacy-filter
- OpenAI Privacy Filter announcement: https://openai.com/index/introducing-openai-privacy-filter/
