# Creator Factory implementation v1

This document describes the implemented distillation workflow. It supersedes the older P01–P18 prompt graph for this workflow; it does not change the consumer Runtime or automatically publish a Corpus.

## Unit and roles

One run handles one Creator × one Task and produces a numbered candidate lineage; initial compilation, Development calibration, and failure correction may each add a candidate, and the latest one is evaluated. There are only three Factory LLM roles:

- Evidence LLM extracts traceable method, judgment, cases, boundaries, and intellectual genealogy.
- Eval LLM generates questions for the Creator, then later judges Hatch results against Creator answers.
- Corpus LLM builds and revises the complete layered cognitive asset set: always-on System plus every evidence-justified Skill, Skill-local reference, and retrieval-only knowledge document.

These three Factory roles use the Factory-owned Kimi K3 profile: 1,048,576-token context, maximum reasoning effort, and K3's native sampling contract. Hatch candidate execution is not a fourth Factory LLM. A one-shot CLI starts the existing product Runtime, binds a verified candidate Agent Corpus through the production WebSocket session, and lets Runtime retain its own model and behavior. No Factory model option is passed across this boundary. There is no end-user workspace at build time, so the eval session advertises no buyer-local tools; the canonical bundle still declares Hatch's built-ins and the full Runtime owns Corpus materialization, server tools, output guard, turn state, and trace events.

This is prompt-and-corpus compilation with generated evaluation, not model training, fine-tuning, or an ML data pipeline.

## Workflow

```text
authorized sources
  → Evidence LLM
  → Eval LLM generates Questions
  → wait for Creator Answers
  → code freezes Development QA and sealed Held-out QA
  → Corpus LLM compiles candidate
  → code materializes complete provisional Agent Corpus
  → Registry verifier checks manifest, assets, binding, paths, and whole digest
  → Hatch executes Development Questions
  → Eval LLM compares Question + Creator Answer + Hatch Result
  → feedback / few-shot candidates / reflections / failures
  → Corpus LLM completes calibration
  → all Development cases enter Regression
  → every Corpus change reruns the full Regression Set
  → Hatch executes sealed Held-out
      pass → candidate ready (not published)
      fail → failed cases become Regression
             → Corpus LLM revises
             → full Regression
             → Eval LLM generates fresh Questions
             → wait for fresh Creator Answers
             → new sealed Held-out
```

Development QA is the only initial QA visible to Corpus. For an active held-out case, Corpus sees neither Question nor Answer. Because the Agent Corpus contract requires a held-out asset even before release, the staged candidate contains a host-authored empty placeholder: it contains no active Question, Creator answer, result, or active-set digest. The product Runtime's live materializer does not read evaluation assets, so Hatch sees only the current Question and never the Creator reference Answer. Eval judging sees that Question, its Creator Answer, and Hatch's result. Only after the active Held-out round passes does Factory rematerialize the candidate with the complete canonical Held-out evaluation. When a replacement batch is generated, Eval question-generation receives only summaries of historical Questions and their leakage-group tags for deduplication, never their Creator Answers. After a held-out failure, that failed QA loses held-out status and is deliberately promoted to the visible Regression Set.

## Prompt design contract

A prompt in this workflow has one cognitive job. Static role instructions are separated from dynamic run context. Every role has an operational worldview and value hierarchy, not merely a mechanical checklist: Creator fidelity outranks generic model taste; epistemic honesty outranks cosmetic completeness; paid-worthy finished output outranks internal-looking drafts; when those are satisfied, completeness and durable capability outrank brevity. Every prompt also states authority order, visibility boundaries, how to transform inputs, and what uncertainty must remain explicit.

The model is not asked to reproduce a giant JSON object or a fragile Markdown delimiter template. It receives the complete natural-language context and submits finished parts through stage-local, side-effect-free tools: Evidence sections, generated Questions, an Eval verdict, or individual System/Skill/reference/knowledge and audit assets. Tool metadata stays shallow while authored bodies remain unrestricted Markdown. The host captures the raw streamed arguments, requires strict JSON parsing to match the adapter's parsed value exactly, executes calls sequentially in a turn-transactional in-memory builder, returns receipts that never echo long content, and accepts a node only after its finalizer freezes a complete result. Truncated, salvaged, prose-only, unfinalized, conflicting, or schema-invalid submissions fail closed. The host then renders the accepted typed parts into the existing canonical readable Markdown and runs the deterministic parser and Agent Corpus verifier as a second boundary.

Corpus revisions are complete replacements of every layer and asset, never deltas or summaries. The compiler must inventory requirements, trace every requirement to a real emitted asset, retain every still-valid prior asset and behavior by default, and itemize retained, added, removed, merged, conflict-resolved, renamed, path-changed, or layer-moved material. A routing recommendation without the destination asset's full content is a compilation failure. A separate Eval-mode completeness audit compares the entire prior and candidate compilation; deterministic continuity checks independently block unaccounted asset deletion and unexplained per-asset shrinkage.

The authority order is:

1. Creator's current answer or correction;
2. Creator canonical examples;
3. Creator-authorized private material;
4. supplied public background;
5. model inference.

Good prose is not the acceptance criterion. Development, Regression, and sealed Held-out behavior determine whether the Corpus is useful and stays useful.

## Run the vertical slice

The CLI uses the dedicated Factory Kimi K3 prompt gateway and requires `LLM_API_KEY` plus the configured Moonshot-compatible `OPENAI_BASE_URL`. Candidate tests spawn the existing Hatch Runtime in a child process, whose model remains Runtime-owned.

```bash
cd runtime-server
npm run factory -- start \
  --input ../fixtures/creator-factory/minimal/factory-input.json \
  --root ../artifacts/creator-factory-runs
```

`start` owns its run directory exclusively. Reusing an existing run ID—or a partial directory left by an interrupted start—fails before any Factory LLM call or run-artifact write; use `resume`/`retry` for recovery or choose a fresh run ID.

The command exits at `awaiting_creator_answers` and prints an absolute `answerTemplate` path plus `questionBatchId`. The template contains exactly one host-generated, run-scoped Question-batch ID marker. Preserve that marker and every Question while filling every `Creator Answer` section, then resume. The sealed Question artifact's SHA-256 is only an integrity checksum; answer authorization uses a fresh nonce-bound ID derived from the run ID and artifact SHA, so byte-identical Questions in another run cannot reuse the answers:

```bash
npm run factory -- resume \
  --run-id demo-offer-critique-v1 \
  --answers "<the answer-template path printed by start>" \
  --root ../artifacts/creator-factory-runs
```

CLI, Engine, Service, Repository, and Worker all require that digest to equal the current sealed Question artifact before parsing or persisting answers. A missing marker, an old template from another run, or a delayed answer for a replaced batch fails closed. If held-out fails, the command again exits at `awaiting_creator_answers` with a newly bound replacement template. `ready` means the candidate passed all quality gates and a complete canonical Agent Corpus has been materialized and verified; Creator approval and Registry publication remain separate operations. Before `ready`, the CLI withholds the provisional bundle root and whole-Corpus digest. At `ready`, it includes the System digest, final whole-Corpus digest, and local bundle root.

Inspect progress without invoking an LLM:

```bash
npm run factory -- status \
  --run-id demo-offer-critique-v1 \
  --root ../artifacts/creator-factory-runs
```

If a transient LLM or Runtime failure leaves a retryable checkpoint in `needs_attention`, retry that exact stage without restarting the run:

```bash
npm run factory -- retry \
  --run-id demo-offer-critique-v1 \
  --root ../artifacts/creator-factory-runs
```

Each run contains `state.json`, an append-only `events.jsonl`, readable artifacts, sealed QA/traces, and immutable numbered Corpus candidates.

## Run it as the product

The production control plane does not need a monitoring Agent. The Registry API writes a durable run row to Postgres; a separate Factory worker atomically claims it, advances the file-backed Graph on the shared private volume, and writes the visible status back to Postgres. The Creator Dashboard only polls while a run is queued or running. When the Graph needs judgment, it stops and exposes the generated Questions; submitting all Creator answers makes that same run claimable again.

```text
Creator Dashboard
  -> authenticated Registry Factory API
  -> Postgres run/lease row
  -> Factory worker
  -> shared private artifact volume
  -> Evidence / Eval / Corpus calls + Hatch Runtime candidate executions
```

The Creator API is:

- `POST /v1/creator/factory-runs` — create one Creator × one Task run; requires `Idempotency-Key`. The request may carry the complete Creator-owned product metadata and declarative tool requirements. Factory validates and persists those fields; no LLM invents price, connection, tool, URL, or credential. Replaying the same key and normalized input returns the existing run; reusing it for different input returns `409 idempotency_conflict`.
- `GET /v1/creator/factory-runs` and `GET /v1/creator/factory-runs/:id` — list or inspect the Creator's own runs.
- `PUT /v1/creator/factory-runs/:id/answers` — submit all answers for the current generated batch; `question_batch_id` is required, while a stable `submission_id` and `expected_version` make transport retries and optimistic concurrency explicit.
- `POST /v1/creator/factory-runs/:id/retry` — explicitly requeue only a `needs_attention` run whose response says `retryable: true`.

`creator_id` never comes from request data; Registry derives it from the authenticated Creator account. The public projection contains identity, Task name, control status, Graph stage, optimistic version, retryability, timestamps, optional error, and latest candidate metadata. A single-run detail also returns pending Questions and `question_batch_id` only while waiting for the Creator. It never returns artifact paths, prompts, source material, Creator reference answers, or held-out contents.

Create and answer submission are idempotent operations. A create key is bound to the complete normalized run input. For answers, a reliable client returns the opaque run-scoped `question_batch_id`, a stable `submission_id`, `expected_version`, and one structured answer for every pending Question. Replaying the same submission ID with the same ordered payload and batch token is safe across queued, running, or a later waiting state. Reusing that ID for different content, or sending an unseen submission for an old/unknown batch, returns 409. Legacy states or submissions without the nonce-bound batch ID fail closed. This prevents a delayed retry—or an identical batch from another run—from applying old answers to the current Questions.

The existing app compose file includes the worker and the shared volume. This is the application-layer command used after `.env`, image release variables, the external `hatch_internal` network, Postgres, and Qdrant have been provisioned (the deployment workflow and `compose.infra.yml` own those prerequisites):

```bash
HATCH_DOMAIN=hatch.example.com \
HATCH_REGISTRY_DATABASE_URL=postgresql://... \
docker compose -f compose.app.yml up -d
```

The worker uses the same provider credential but a Factory-specific Kimi K3 model profile; the Hatch child keeps Runtime's own model profile. Relevant optional settings are `HATCH_CREATOR_FACTORY_ROOT`, `HATCH_CREATOR_FACTORY_WORKER_ID`, `HATCH_CREATOR_FACTORY_LEASE_MS`, `HATCH_CREATOR_FACTORY_HEARTBEAT_MS`, `HATCH_CREATOR_FACTORY_POLL_MS`, and `HATCH_CREATOR_FACTORY_HATCH_TIMEOUT_MS`. Production must use Postgres and a volume mounted at the same Factory root in Registry and worker. The in-memory repository is only a local/test fallback and cannot coordinate a separate worker.

V1 deploys one `factory-worker` replica. Postgres claiming, heartbeat, retry scheduling, and fencing use the database clock and survive process restart, but the private file artifact commit is not a database transaction. Do not horizontally scale this worker until artifact commits use lease-token staging or transactional object storage.

Before each Development, Regression, or Held-out batch, Factory writes the complete candidate tree: `agent.json`, `instructions/system.md`, every compiled `skills/*/SKILL.md` and Skill reference, every compiled `knowledge/*.md`, and both required eval assets. Until Held-out PASS, `evals/held-out.json` is the host-owned empty placeholder; it is never populated from the active sealed set. Paths are derived deterministically from validated IDs; every byte receives a SHA before the manifest is written. Factory declares both Hatch built-ins plus only Creator-explicit tool requirements, validates Skill tool scopes, and runs the Registry verifier on the whole bundle. The one-shot CLI copies that verified snapshot to an isolated temporary corpus root, starts `createRuntimeServer()`, performs `client.hello → session.ready → client.message`, verifies the bound whole-Corpus digest, and accepts output only after both `turn.completed/stop` and `turn.state/completed`. It never calls a simplified prompt-only candidate path. Staged knowledge uses Runtime's existing corpus-backed retrieval adapter so unpublished documents can be evaluated without touching production indexes. Since no end user participates at build time, the session advertises `local_tools: []`; write/shell approval is never fabricated.

The operator-facing CLI can provide a loose `source_scope` containing only `pack_root` and `creator_directory`. Factory recursively snapshots every regular UTF-8 file in that directory; the operator cannot select a relevance subset. It derives the inventory, byte counts, per-file SHA-256 values, and a root digest internally, persists the frozen manifest, and revalidates it at every resume boundary. Optional checksum or manifest inputs strengthen integrity but are not required to describe the material. HTTP Creator source text and the Task brief retain the 5 MiB semantic limit and 100-source limit; Registry and Dashboard accept a 32 MiB JSON envelope so escaping and request metadata do not reduce that semantic limit. Factory never truncates a large authorized packet to fit one call: it losslessly partitions the complete packet into context-safe Evidence calls, then uses the same Evidence LLM in a preservation-audited consolidation pass. Every fragment, citation, contradiction, and distinct rule must be accounted for.

Every Factory LLM call and Hatch candidate execution writes an atomic execution record before it starts and settles it with a monotonic `elapsedMs` on completion, failure, or cancellation. Wall-clock timestamps are audit orientation only. Per-QA Hatch and Eval results use digest-bound two-phase checkpoints, so retry skips a completed Eval, resumes after a completed Hatch, and never reconstructs work from a trace. Held-out timing and checkpoints are themselves sealed. Operators can inspect true node attempts with `factory timings`; a crash may leave an explicit running/abandoned record but is never reported as a fabricated duration.

Authorized source contents are private application data. They live in the durable queued input and are materialized on the private Factory volume so a worker can resume after restart. Database access, volume access, backups, and retention therefore need the same controls as paid course material. Only the explicitly promoted failures cross from sealed held-out into the visible Regression Set.

## Release boundary

`ready` means all of the following are true: Development calibration completed; the latest candidate passed the complete Regression Set (including all Development cases and promoted failures); the active sealed Held-out round passed; the clean canonical Agent Corpus directory was materialized; creator/agent binding and every asset digest passed the Registry verifier; and the verified whole-Corpus digest was persisted. The bundle contains only manifest/runtime/eval assets—never source packets, evidence ledgers, Factory prompts, compile records, traces, credentials, or runtime configuration.

Optional does not mean ignored. A simple one-Task Agent may validly have `skills: []` and `knowledge.documents: []` only when the evidence justifies no local reusable unit or retrieval-only long tail. When evidence routes a requirement to Skill, reference, or knowledge, the complete asset must exist in the candidate, survive revision accounting, enter `agent.json`, and pass whole-bundle verification. Both `hatch.web_search` and `hatch.file_search` are always declared; additional local/HTTP/MCP capabilities must be explicitly supplied by the Creator/operator and never inferred by an LLM. `ready` does not publish or replace the Registry's current Corpus. Creator approval and an explicit Registry promotion remain a separate release action, so retries can never change a live product by themselves.

## Verification

```bash
cd runtime-server && npm test
cd ../creator-dashboard && npm test && npm run build
cd .. && HATCH_DOMAIN=factory.example.test \
  HATCH_REGISTRY_DATABASE_URL=postgresql://hatch:hatch@postgres:5432/hatch \
  docker compose -f compose.app.yml config --quiet
```

The repository test suite covers Graph semantics, sealed held-out isolation, Development calibration, complete Regression reruns, replacement held-out batches, prompt-injection boundaries, candidate Runtime tool isolation, resumable checkpoints, Postgres lease fencing, create/answer idempotency, Creator ownership, request limits, Worker resume behavior, and the Dashboard control path.
