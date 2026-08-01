# Hatch v1 execution contract

This document is the shared acceptance contract for the Consumer Desktop,
Creator Factory, Runtime, Registry, Commerce Ledger, and Creator Dashboard.
It is intentionally product-oriented: an implementation is not complete merely
because its individual API or screen works.

## Demonstration identities

### Creator: Maya Chen

- Product: **Signal Resume Review**
- Existing business: career education and resume coaching
- Source material: prior course exports, PDF, video/audio recordings, plain
  text, examples, and historical deliverables as they already exist; Maya does
  not prepare a manifest, prompt, schema, claim map, or test plan
- Product promise: inspect a user's real resume and evidence files, then produce
  a usable evidence review in Maya's method
- Product boundary: does not guarantee an interview or job outcome

### Buyer: Jordan Lee

- Has purchased Maya's product
- Uses the installed Hatch Desktop
- Grants a single workspace containing synthetic resume and evidence files
- Cannot access Maya's protected prompt, Skill, RAG corpus, Evals, revenue, or
  other buyers' data

## Creator flow

The Creator Factory is an internal Codex workflow, not a Creator-facing
configuration product and not a task-by-task human review queue. Its internal
representations are implementation details; they must not become work the
Creator is asked to perform.

```text
Maya drops in existing course / PDF / video / text
  -> Hatch transcribes, extracts, cleans, deduplicates, and preserves provenance
  -> Hatch distills what Maya knows, how she decides, and what she leaves out
  -> Hatch expands plausible adjacent and boundary cases without inventing authority
  -> Hatch builds RAG, system prompt, Skills, required API/tool adapters,
     and a Release-bound delivery audit workflow
  -> Hatch installs the candidate on the existing cloud Runtime
  -> the candidate completes real tasks and is tested against a generic baseline
  -> Hatch runs representative Evals / synthetic QA and applies automatic release gates
  -> the version becomes ready to publish; Maya can choose when to make her product live
  -> Hatch publishes the immutable Creator Release
```

The flow passes only when:

1. The only Creator input is existing material plus normal product intent in
   natural language. No JSON, claim annotation, prompt writing, RAG curation,
   or Eval authoring is delegated to the Creator.
2. A PDF, video, or course export can enter without manual conversion; every
   extracted passage remains traceable to the original file and location or
   timestamp.
3. The generated Agent is functional on the existing Runtime. It can retrieve
   from its RAG corpus, follow its protected Skill and system prompt, call every
   API/external tool required by its promise, and use Consumer-approved local
   tools through Desktop.
4. The Agent preserves Maya's priorities, omissions, quality bar, and refusal
   boundaries—not merely the vocabulary or topics of the course.
5. Synthetic expansion includes direct, composed, boundary, and out-of-scope
   cases, but never invents Creator authority, facts, or guarantees.
6. Release Evals are held out from generation examples and test observable
   behavior. A competent generic model may give a reasonable answer and still
   lose because it misses Maya's selection, ordering, or omission.
7. Hatch validates the actual running Agent against representative answers and
   release gates before it can be published. The Creator is not asked to
   inspect compiler artifacts, write Evals, or act as a task-by-task reviewer.
8. The Release is versioned, digest-addressed, cannot be silently overwritten,
   and never exposes private runtime assets to the Consumer.
9. Prompt adherence alone is not accepted as delivery control. The Release
   declares a server-private `draft -> atomic-claim audit -> revise` workflow.
   Every factual, causal, outcome, authority, and scope claim in a proposed
   response or artifact must be entailed by an evidence source with the right
   authority and comply with the product boundaries. User-specific facts may
   be supported only by user input or approved tool evidence. Protected Creator
   knowledge may supply method, criteria, and advice, but can never prove a fact
   about the user. Unsafe drafts are revised automatically and are never shown
   to the Consumer. The Runtime deterministically divides every proposed
   Markdown response or artifact into claim units; the reviewer must cover every
   unit and every atomic claim within it. Missing or unknown coverage, or an
   over-limit artifact, fails closed rather than being treated as a clean review.
   Reviews run in bounded five-unit batches and retry malformed structured
   responses. Each batch receives only its own draft fragment, the product
   promise and boundaries, relevant retrieved Creator knowledge and few-shots,
   plus user or approved-tool evidence. The full system prompt and Skill remain
   execution instructions; they are never repeated into the reviewer as factual
   evidence. The reviewer returns claim verdicts only; it cannot self-declare a
   pass. Factory and Runtime compute the pass deterministically from complete
   unit coverage and all-entailed verdicts.

## Creator Release

A Release is the only artifact that may connect Factory output to Runtime.

The word "output" has three deliberately separate meanings. The Factory build
workspace may be rich and Creator-specific; the review pack may contain tests
and representative answers; the **publishable output** is only the minimal
immutable Release. Registry, Runtime, Desktop, Dashboard, and Commerce must
never depend on the build workspace or review pack.

Public fields:

- `release_id`, `product_id`, `creator_id`, semantic version, and digest
- Creator identity, product name, description, promise, boundaries, price and
  pricing model (`per_delivery` or `subscription`), and supported local
  capabilities
- Client-safe presentation metadata

Server-private fields:

- system prompt and protected Skill bundle
- normalized RAG documents/chunks with provenance
- selected few-shots needed at inference time
- runtime/tool policy, including the canonical delivery audit and revision
  instructions used by both semantic UAT and the production Runtime

Factory-only review and work fields:

- synthetic Q&A and development/release Evals
- representative run outputs and automatic release-gate evidence
- raw/extracted sources, distillation traces, and rejected material

These stay outside the immutable Runtime Release. The Factory may retain them;
the Runtime does not load them to serve the Agent.

The Desktop resolves a specific published Release through the Registry. The
Runtime independently materializes the private side of the same digest.

### Portability boundary

The Release contract is Creator- and domain-agnostic. Creator identity,
language, knowledge, method, examples, and tool configuration are payload; they
are never compiler branches, Runtime routes, Desktop components, Dashboard
navigation, protocol fields, or commerce semantics. A resume Creator and an
unrelated Creator must pass through the same Factory → Registry → Runtime →
Desktop/Dashboard implementation without product-code changes.

This does not mean flattening every Creator into a generic Agent. The container
and lifecycle are generic; the payload is not. A Release may carry a unique
system prompt, Skill bundle, RAG corpus, few-shots, presentation metadata, and
declarative tool policy. Adding another Creator must require new raw material
and a new compiled Release, never a new application surface, route, protocol
field, compiler condition, or Creator-specific Runtime adapter. A genuinely new
external system may require one reusable capability adapter, but that adapter
must not contain the Creator's method or product logic; the Release only binds
and configures it declaratively.

The publishable package must be clean enough to copy into an empty Release root
and load without any path back to its Factory workspace. It must contain no raw
course files, distillation traces, expected Eval answers, review state, demo
identity, proof path, or scenario-specific orchestration code.

The Factory's internal source pack is generated by the Codex workflow from raw
materials. It is not an input form and is not proof by itself. Every internal
field must support a real need—provenance, operational behavior, retrieval,
tooling, evaluation, or release integrity—and must not exist merely to make the
build look complete.

## Consumer flow

```text
Jordan installs Hatch
  -> signs in
  -> opens Maya's already-published Agent
  -> grants one workspace
  -> asks a normal, open-ended question
  -> cloud Runtime invokes Maya's Release
  -> requested local tools execute through Tauri/Rust
  -> proposed responses and artifact writes pass the Release delivery audit
  -> Jordan approves consequential actions
  -> a usable artifact is delivered locally
  -> the Task and Delivery survive restart
```

The Desktop is a generic Creator Agent surface. It must not encode a resume,
legal, marketing, or other use case as the application navigation or default
task. Internal terms such as Runtime, protocol, tool broker, manifest, event
stream, and local runner are not primary product UI.

The flow passes only when:

1. Before an order or entitlement is created, the live Registry resolves the
   exact `release_id + release_digest` as published; post-hoc publication does
   not satisfy the connected flow.
2. Read access is limited to the workspace Jordan chose.
3. Write, patch, and shell behavior follows an explicit user-facing policy.
4. Disconnects, denied permissions, and recoverable tool failures do not lose
   the paid use or silently discard an active Task.
5. Duplicate messages or tool results cannot create duplicate Deliveries or
   charges.
6. Jordan cannot request another buyer's history or a Creator-only endpoint.
7. A proposed file write that fails the Release claim/boundary audit never
   reaches Desktop approval and never mutates the workspace. Drafts, reviewer
   output, and revision traces remain server-private; only the validated final
   answer or a fail-closed boundary-safe partial response is user-visible.

## Commerce and Creator Dashboard

One append-only Ledger is the source for both Consumer entitlement and Creator
revenue. For the demonstration product, one successful paid order records:

- gross: `3900` minor units
- Creator share: `3510`
- Hatch share: `390`

The Creator Dashboard is a standard SaaS surface. Maya sees her products,
orders, deliveries, gross revenue, Creator share, Hatch share, and aggregate
runtime health. It does not expose raw buyer messages, raw local files, Factory
internals, or a per-task review inbox.

Publishing unlocks only when the immutable package, live Runtime UAT, and a
same-digest blind comparison have passed. Completing a generic-baseline run by
itself is not sufficient: the Creator Agent must clear the declared quality
threshold and show a strict positive difference over that baseline.

## Brand contract

Desktop and Creator Dashboard consume the same Hatch brand package rather than
recreating the website by eye. `packages/brand` is the source of truth for the
Hatch mark, warm-paper palette, and typography:

- `Instrument Serif` with bundled `Noto Serif SC Variable` for Chinese brand
  and major product headings
- `Inter Variable` plus bundled `Noto Sans SC Variable` for product UI
- `DM Mono` only for compact labels, Release identity, and machine state;
  large prices, revenue, and product metrics use the display serif, matching the
  website's numeric hierarchy

The application bundles these fonts so product rendering does not depend on
network access or fonts installed on the user's machine. Creator identity can
shape the Agent's content and experience, but must not fork the Hatch shell's
navigation, typography, or base palette.

## Model contract

Hatch v1 uses `kimi-k2.6` for every model-mediated role: Factory semantic
distillation/UAT, Creator-Agent candidate generation, delivery claim audit and
revision, blind held-out judging, live Runtime turns, and context compaction.
The roles may remain separately configurable for future releases, but v1 must
fail closed if any resolves to another model. Every proof artifact records the
effective model and provider endpoint; no implicit provider fallback,
mixed-model evidence, or earlier Qwen/GPT-OSS/DeepSeek result can satisfy a
final gate.

Moonshot credentials are injected through process environment only. They do
not enter git, Factory work/review output, the immutable Creator Release,
Registry metadata, Desktop state, screenshots, or proof logs.

## Required proof

Completion requires reproducible evidence from one connected run. A valid file
bundle without a successful Runtime task is not proof of completion:

- the unmodified raw Creator inputs used in the run, including at least one PDF
  or video and one text/course asset
- ingestion output with source locations/timestamps, plus evidence that no
  manual semantic manifest was supplied
- the generated RAG, system prompt, Skills, tool adapters, synthetic QA, and
  held-out Evals
- generic-baseline and Creator-Agent outputs on the same held-out tasks, with
  behavior-based scoring
- a delivery-workflow trace proving an unsafe draft was detected and revised,
  while the Consumer-visible response and local artifact contain only the
  validated result
- automatic release-gate evidence produced from actual Runtime runs
- Release manifest and digests only after the functional and behavioral gates
  pass
- Registry record proving the published digest
- Desktop screenshots from the installed application
- local artifact and its digest
- Task, Artifact, Delivery, Order, and Ledger identifiers linked across systems
- Dashboard screenshots backed by the same Ledger records
- automated tests for the happy path, access isolation, retry/idempotency, and
  protected-asset boundary
