# Hatch

Hatch turns an expert creator's courses, methods, data, and tools into a paid
Creator Agent that can work against a buyer's real local context.

This repository contains two connected flows:

```text
Creator sources
  -> internal Creator Factory
  -> current Agent Corpus
  -> Registry + cloud Runtime

Buyer Desktop
  -> selected local workspace
  -> Creator Agent
  -> approved local tool execution
  -> usable artifact + Delivery
```

The authoritative agent contract is
[packages/protocol/AGENT_CORPUS.md](packages/protocol/AGENT_CORPUS.md).

The connected demonstration follows two concrete people rather than anonymous
test fixtures:

- Creator [Maya Chen](fixtures/profiles/maya-chen.md)
  distills and publishes Signal Resume Review from her existing materials.
- Buyer [Jordan Lee](fixtures/profiles/jordan-lee.md) purchases
  that product, grants a job-search workspace, and receives a local artifact.

Their identities exist only in demonstration inputs and proof orchestration;
Factory, Runtime, Desktop, Registry, Commerce, and Dashboard product code remain
Creator- and domain-agnostic.

## Active architecture

### Consumer Desktop

`desktop-app/` is the existing Tauri/React application. It owns the buyer-facing
chat experience and invokes the Rust native boundary for local tools.

`local-runner/` implements workspace-contained filesystem operations, patches,
shell policy, git diff, and the local audit trail. It never owns model reasoning
or Creator instructions.

### Cloud agent Runtime

`runtime-server/` is the single Consumer Runtime. It owns model calls,
conversation state, server-side tools, protected Skill execution, and the
WebSocket tool broker used by the Desktop.

The canonical wire protocol is version `0.3` and lives in
`packages/protocol/schemas/hatch-wire-protocol.schema.json`.

Creator-private prompts, Skills, RAG material, Evals, and synthetic Q&A remain
server-side. The Desktop receives only client-safe product metadata and runtime
events.

### Creator production and publishing

`creator-agent-factory/` is an internal Codex Skill/workflow. It converts raw
source material into a clean, runnable Agent Corpus. It is not a Creator-facing
task-review product.

`platform-registry/` verifies and stores one current Agent Corpus per
`tenant_id + agent_id`, builds its isolated knowledge index, and serves the
runtime-facing tool bindings. It never returns private instructions or secrets
to a client.

`packages/commerce/` provides the append-only Ledger and projections shared by
buyer entitlement and Creator revenue reporting.

`creator-dashboard/` is the Creator-facing SaaS surface for viewing orders,
deliveries, and the 90/10 revenue projection from that same Ledger.

## Repository map

```text
creator-agent-factory/   internal distillation Skill and Agent Corpus workflow
desktop-app/             Tauri/React Consumer application
local-runner/            Rust local tool boundary
runtime-server/          TypeScript cloud agent Runtime
platform-registry/       Agent Corpus registry and tool control plane
packages/protocol/       canonical wire and Agent Corpus schemas
packages/commerce/       entitlement, Delivery, and revenue Ledger
landing/                 public website
docs/                    product contracts and proof artifacts
```

Protected Creator Skills run inside the TypeScript Runtime.

## Local development

Copy `.env.example` to `.env`, supply a Moonshot credential, then run:

```bash
./scripts/dev.sh
```

Hatch uses `kimi-k2.6` for Creator-Agent generation, Runtime turns, and
context compaction. There is no silent model fallback. Provider credentials
remain process environment only and must never enter an Agent Corpus.

The Desktop connects to the TypeScript Runtime at
`ws://127.0.0.1:8400/runtime` by default.

Component verification:

```bash
cd runtime-server && corepack pnpm install --frozen-lockfile && corepack pnpm test
cd ../local-runner && cargo test
cd ../desktop-app && npm ci && npm run build:web
cd ../desktop-app && npm run build:dmg:ci
cd src-tauri && cargo test
cd ../../packages/commerce && npm test
```

The DMG command creates the installable macOS bundle without relying on Finder
automation. Developer builds are intentionally unsigned; public distribution
still requires Apple Developer signing and notarization credentials.

Passing component tests is not sufficient proof. Completion requires raw
Creator material to be distilled and published as an Agent Corpus, consumed
from the installed Desktop, and delivered through local tools.
