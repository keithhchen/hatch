# Hatch

Hatch turns an expert creator's courses, methods, data, and tools into a paid
Creator Agent that can work against a buyer's real local context.

This repository contains two connected flows:

```text
Creator sources
  -> Creator Factory Graph (Evidence / Eval / Corpus)
  -> Creator-reviewed candidate Corpus
  -> explicit approval and publication
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

Creator-private prompts, Skills, RAG material, generated Eval Questions, and
Creator reference answers remain server-side. The Desktop receives only
client-safe product metadata and runtime events.

### Creator production and publishing

Creator Factory v1 is a durable Graph implemented under
`runtime-server/src/creatorLearning/`. One run handles one Creator, one bounded
Task, and one numbered candidate lineage. Its Evidence, Eval, and Corpus LLM roles pause
for the Creator's generated-task answers, keep held-out cases sealed, calibrate
on Development, rerun the complete Regression Set after every Corpus change,
materialize and verify a complete provisional Agent Corpus before every candidate
execution, and invoke Hatch's existing full Runtime through an isolated one-shot
CLI. Corpus compilation is genuinely layered: every evidence-justified System,
Skill, Skill reference, and retrieval-only knowledge asset is emitted in full,
hashed, declared in `agent.json`, and preserved across revisions. Optional layers
may be empty only when the evidence does not require them; routing a requirement
to an asset that was not materialized fails the run. The Creator Dashboard
starts and resumes runs; Postgres and a dedicated worker own durable scheduling.
See [Creator Factory implementation v1](docs/creator-factory-implementation-v1.md).

`creator-agent-factory/` is retained as the earlier manual Skill-based authoring
path. It is not the production orchestrator for the v1 Graph.

The TypeScript Registry in `runtime-server/src/registryServer.ts` verifies and
installs each Agent Corpus as an immutable digest-addressed release, then
atomically switches the current pointer. Purchased entitlements keep resolving
their pinned digest after later publications or rollbacks.
The Registry catalog keeps the current `(creator_id, agent_id)` metadata row;
the separate Creator Factory run table durably stores its authorized input and
minimal control state so work can resume after a restart. Both that table and
the private Factory artifact volume must therefore be protected as Creator
source data. Credentials and vector contents do not enter Factory artifacts.
The old `platform-registry/` Python service is migration-only and is not the
production entrypoint.

`packages/commerce/` provides the order, offer-revision, entitlement,
delivery-unit, refund, revenue, and payout contracts. Production uses its
PostgreSQL event repository with transactional outbox/inbox and a single
Dashboard-hosted command API; the file ledger remains a local-test fallback.
Production Compose gives Registry, Factory, Runtime, and Commerce distinct
database login roles, and exposes only the credentials each service needs.

`creator-dashboard/` is the Creator-facing SaaS surface for starting and
resuming Factory runs, and for viewing published Agent products, orders,
deliveries, and the 90/10 revenue projection from that same Ledger. Publication
remains an explicit action after a candidate reaches `ready`.

## Repository map

```text
creator-agent-factory/   earlier manual Skill-based authoring path
desktop-app/             Tauri/React Consumer application
local-runner/            Rust local tool boundary
runtime-server/          TypeScript Runtime + Registry + Creator Factory Graph/worker
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

Hatch product Runtime remains on its existing `kimi-k2.6` path. Creator Factory's
three LLM roles—Evidence, Eval, and Corpus—use a separate `kimi-k3` profile with
the 1,048,576-token context profile and maximum reasoning effort; that Factory
profile is never passed into candidate Runtime execution. These roles do not
silently fall back to another model. Provider credentials
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
