# Hatch

Hatch turns an expert creator's courses, methods, data, and tools into a paid
Creator Agent that can work against a buyer's real local context.

This repository contains two connected flows:

```text
Creator sources
  -> internal Creator Factory Skill
  -> current Agent Corpus
  -> Registry (Postgres metadata + POSIX assets) + cloud Runtime

Buyer Desktop
  -> selected local workspace
  -> Creator Agent
  -> approved local tool execution
  -> usable artifact + Delivery
```

The canonical product/runtime contract is the current
[Agent Corpus v1](packages/protocol/AGENT_CORPUS.md) plus the
[wire protocol 0.6](packages/protocol/schemas/hatch-wire-protocol.schema.json).

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

The canonical wire protocol is version `0.6` and lives in
`packages/protocol/schemas/hatch-wire-protocol.schema.json`.

Creator-private prompts, Skills, RAG material, Evals, and synthetic Q&A remain
server-side. The Desktop receives only client-safe product metadata and runtime
events.

### Creator production and publishing

`creator-agent-factory/` is an internal, host-independent Codex Skill. It reads
ordinary Creator materials and writes a clean Agent Corpus: system
instructions, optional local Skills and references, optional retrieval-only
knowledge, tools, and evaluation assets. It does not start Runtime, configure a
database, or require the operator to fill JSON.

The TypeScript Registry in `runtime-server/src/registryServer.ts` verifies and
installs the current Agent Corpus into the shared POSIX corpus root.
PostgreSQL stores only the current `(creator_id, agent_id)` metadata row; it
never stores prompts, Skills, source material, credentials, or vector contents.
The old `platform-registry/` Python service is migration-only and is not the
production entrypoint.

`packages/commerce/` provides the append-only Ledger and projections shared by
buyer entitlement and Creator revenue reporting.

`creator-dashboard/` is the Creator-facing SaaS surface for viewing published
Agent products, orders, deliveries, and the 90/10 revenue projection from that
same Ledger. Publication itself is owned by the Factory-to-Registry path.

## Repository map

```text
creator-agent-factory/   internal distillation and Agent Corpus publish workflow
desktop-app/             Tauri/React Consumer application
local-runner/            Rust local tool boundary
runtime-server/          TypeScript cloud Agent Runtime + Registry
platform-registry/       legacy Registry migration source
packages/protocol/       canonical wire and Agent Corpus schemas
packages/commerce/       entitlement, Delivery, and revenue Ledger
privacyd/                optional local privacy transformation experiments
archive/landing-skill-app/ historical website (not deployed)
docs/                    product contracts and proof artifacts
```

The TypeScript Runtime loads the Registry-installed Corpus directly. It always
loads `instructions/system.md`, activates only the relevant local Skill and its
references, queries the Agent-scoped knowledge provider when configured, and
merges Hatch built-ins with declared Creator tools. Evals never enter the live
context. Protected Creator Skills run inside the TypeScript Runtime.

## Local development

Copy `.env.example` to `.env`, supply a Moonshot credential, then run:

```bash
./scripts/dev.sh
```

Hatch v1 deliberately uses `kimi-k2.6` for Creator-Agent generation,
delivery auditing, blind evaluation, Runtime turns, and context compaction.
These roles do not silently fall back to another model. Provider credentials
remain process environment only and must never enter an Agent Corpus or proof
bundle.

The Desktop connects to the TypeScript Runtime at
`wss://hatch.tokenquadrant.cn/v1/runtime` by default; local development does not start a Runtime.

Component verification:

```bash
cd runtime-server && npm ci && npm test
cd ../local-runner && cargo test
cd ../desktop-app && npm ci && npm run build:web
cd ../desktop-app && npm run build:dmg:ci
cd src-tauri && cargo test
cd ../../packages/commerce && npm test
```

The DMG command creates the installable macOS bundle without relying on Finder
automation. Developer builds are intentionally unsigned; public distribution
still requires Apple Developer signing and notarization credentials.

Passing component tests is not sufficient proof of v1. Completion requires one
Agent Corpus to be distilled and published, consumed from the installed Desktop,
delivered through local tools, and reflected in the same Commerce Ledger and
Creator Dashboard.
