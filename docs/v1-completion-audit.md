# Hatch V1 completion audit

This is the product acceptance ledger for the connected Maya Chen / Jordan Lee
demonstration. A component test supports a row but does not replace the
cross-system evidence named in the final column. The canonical connected
Release is `signal-resume-review@1.0.0` at
`sha256:d806cf915b29fa952e43ab4aaf02431cc39dfdde6a29b0d20509a07562eaaec5`.

| Product outcome | Current state | Completion evidence required |
| --- | --- | --- |
| Every model-mediated v1 role uses Kimi 2.6 and no mixed-model evidence | **Verified** | Factory `agent-run.json`, blind comparison, and Runtime tests record `kimi-k2.6`; `runtime-server/src/kimiProvider.test.ts` rejects alternate-model and OpenAI-key fallback. |
| Factory, Release, Runtime, Desktop, and Dashboard remain Creator/domain agnostic | **Verified** | `docs/proof/v1-connected/release-portability.json` resolves and materializes Maya's resume product and Ari's unrelated strength-planning product from isolated Release roots with the same Runtime. |
| Maya supplies ordinary course/PDF/video/text, not compiler inputs | **Verified** | Factory intake accepts ordinary files and a natural-language intent; the completed Maya Factory run records only Kimi semantic execution plus mechanical intake/compiler validation. |
| Factory distills method rather than paraphrasing content | **Verified** | The final Factory work tree contains source facts, derived rules, priorities, omissions, boundaries, and a clean runtime Release. `semantic_script` is explicitly `null`; Kimi executes `creator-agent-factory/SKILL.md`. |
| Factory expands beyond the literal course without inventing authority | **Verified** | Both completed Factory runs produce 8 separated synthetic QA items and 4 held-out Evals; these remain under Factory `review/` and do not enter Runtime Release payloads. |
| Creator Agent beats a generic baseline on Maya-specific behavior | **Verified** | `connected-run.json` binds the canonical digest to the Kimi-only blind comparison: Creator Agent `0.889` versus generic baseline `0.556`, a strict `+0.333` delta. |
| Candidate Agent runs on the existing Runtime before publish | **Verified locally** | The connected proof resolves the exact immutable Release from Registry, executes it through the existing Runtime, and confirms the Runtime identity matches Factory output. This is a localhost integration proof, not a deployed cloud Runtime proof. |
| Maya publishes one immutable Release without reviewing individual customer tasks | **Verified** | Publication is Registry-bound to the exact digest. Factory gates and release-level Evals are automatic; the Creator Dashboard is for product/revenue operations, not per-task approval. |
| Jordan obtains the Agent through one paid entitlement | **Verified** | `docs/proof/consumer-e2e-v1/workflow-result.json` binds one entitlement to the canonical Release and one completed paid delivery. |
| Desktop is a generic Agent surface driven by Release metadata | **Verified locally** | Consumer screenshots and workflow evidence use the generic Hatch Agent surface against the canonical Release; renderer tests cover entitlement and product-policy metadata handling. |
| Anyone can install and connect to a cloud Runtime | **Not yet proven** | The distributable Tauri artifact currently defaults to `ws://127.0.0.1:8400/runtime`. This requires a deployed TLS Runtime/Registry endpoint, a production build pinned to that endpoint or a secure first-run configuration path, and an install-from-DMG verification on a clean machine. |
| Registry and Desktop distribution have production identity/signing | **Not yet proven** | Registry publishing currently trusts an internal service token, and the developer DMG is ad-hoc signed but not Apple-notarized. Production identity, credential rotation, signing, updates, and notarization remain open. |
| Agent reads only Jordan's granted workspace and executes local tools | **Verified** | The installed-desktop UAT uses a newly granted workspace, lists/reads its files, requests user approval before `fs.write`, and writes the final artifact only within that workspace. |
| One task creates exactly one artifact, delivery, charge, and revenue split | **Verified** | The installed-desktop UAT asserts the full six-event ledger sequence and exact artifact hash. Runtime retry proof asserts no duplicate Task, Artifact, Delivery, or revenue event. |
| Maya's Dashboard reflects that same delivery and 90/10 split | **Verified** | The same installed-desktop ledger projects one `$39.00` delivery as `$35.10` Creator revenue and `$3.90` Hatch revenue; the UAT asserts Dashboard and Ledger reference the same delivery. |
| Private Creator assets never reach Jordan | **Verified** | Runtime boundary tests and the connected proof verify that system prompt, Skills, RAG, few-shots, synthetic QA, Evals, Factory paths, and review material stay server-side. |
| Task and delivery survive interruption/restart | **Verified** | The connected proof records an idempotent retry after Runtime restart: the same Task, Artifact, and Delivery return with zero new tool requests or revenue recognition. |

## Canonical identity chain

Every final proof must be joinable through this chain. Values are generated by
the connected run; placeholder/demo digests are not accepted.

```text
creator_id
  -> product_id
  -> release_id + release_digest
  -> order_id
  -> entitlement_id
  -> task_id
  -> artifact_id + artifact_digest
  -> delivery_id
  -> recognition_id
```

## Decoupling boundary

The Factory may retain a rich, Creator-specific build workspace, but only the
immutable `release/` package crosses into Registry and Runtime. `review/` is a
release-decision surface and `work/` is Factory evidence; neither is a live
Agent dependency.

The publishable output must be self-contained and clean: it can be copied into
an empty Release root and loaded without the Factory workspace. It contains no
raw course files, distillation traces, expected Eval answers, review state,
mock user identity, proof-directory path, or demo orchestration.

Creator-specific names, domain language, source provenance, method, examples,
knowledge, and tool configuration may exist in raw inputs and generated
artifacts. They must not be encoded in compiler behavior, Runtime routes,
Desktop components, Dashboard information architecture, commerce records, or
protocol field names. Those systems understand only stable product identities,
capabilities, assets, tasks, deliveries, and revenue events.

The decisive portability test is not renaming a fixture. It is compiling a
second, semantically unrelated Creator corpus and running it through the same
Factory → Registry → Runtime → Desktop/Dashboard path without changing product
code.

## Proof surfaces

- `docs/proof/creator-factory-e2e-v1/`: raw intake, Factory work/review/release,
  baseline comparison, and Creator review evidence.
- `docs/proof/consumer-e2e-v1/`: entitlement binding, Runtime/Desktop transcript,
  local artifact, restart/idempotency checks, and Consumer screenshots.
- `docs/proof/creator-dashboard-e2e-v1/`: publish/Registry evidence, shared Ledger
  records, Dashboard API results, and Creator screenshots.
- `docs/proof/v1-connected/`: final cross-system identity manifest and connected
  run summary created only after the three surfaces use the same Release.
