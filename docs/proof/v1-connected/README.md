# Hatch V1 connected proof

This directory joins the Creator and Consumer proof surfaces into one product
run. It is not another fixture: every identifier below is read from the Factory
Release, Registry response, Commerce Ledger, Runtime delivery, local artifact,
or Creator Dashboard projection.

## The two people in the run

- **Maya Chen** supplies existing course, PDF, video/transcript, text, and prior
  work. The Factory automatically produces and gates a functional Agent,
  held-out Evals, and synthetic QA. Maya's Creator surface is for publishing and
  operating a product—not for reviewing individual customer tasks or compiler
  artifacts.
- **Jordan Lee** owns one paid entitlement, opens Maya's product in the generic
  Hatch Desktop, grants one workspace, asks an open-ended question, approves a
  local write, and receives `evidence-review.md` in that workspace.

## One identity chain

`connected-run.json` verifies every join in this chain:

```text
maya-chen
  -> signal-resume-review
  -> signal-resume-review@1.0.0
  -> sha256:d806cf915b29fa952e43ab4aaf02431cc39dfdde6a29b0d20509a07562eaaec5
  -> order_jordan_signal_resume_review
  -> entitlement_jordan_signal_resume_review
  -> task_ac4d5b127729c88c309ca9d7
  -> artifact_13726e2224fca925c720f8c7
  -> sha256:432bfcde3d578abd0edbe894c282c0c0b5b1c49f6d2ad94a145d0a1e7e4e6987
  -> delivery_13726e2224fca925c720f8c7
  -> recognition_delivery_13726e2224fca925c720f8c7
```

All recorded cross-system identity checks pass. The completed delivery recognizes
USD 39.00 gross revenue once: USD 35.10 to Maya and USD 3.90 to Hatch. Retrying
after a Runtime process restart returns the same Task, Artifact, and Delivery;
it makes zero new tool requests, leaves the file unchanged, and creates no
second delivery or revenue event.

## Creator product proof

- `01-creator-ready-and-revenue.png`: Maya's real product and the Ledger-backed
  order/revenue projection.
- `02-creator-release-review.png`: the exact offer, version, gates, and product
  boundaries before publish.
- `03-creator-published-and-revenue.png`: Registry-backed published state plus
  the same Jordan order and 90/10 Creator earnings.
- `04-creator-behavior-review.png`: actual held-out customer prompt and Agent
  answer, what the Eval tested, and a known limitation. This is release-level
  approval evidence, not a per-customer review inbox.
- `registry-publish.json`: Registry's record for the exact Release identity and
  digest.

The canonical Kimi-only blind comparison scores the Creator Agent at `0.889` and the
isolated generic baseline at `0.556`, a strict `+0.333` delta. The comparison is
bound to the same immutable Release digest and does not expose private Creator
assets or expected checks to either contender.

## Consumer product proof

The full installed-Desktop evidence is under `../consumer-e2e-v1/`:

- authenticated purchased-Agent library and workspace grant;
- generic Creator-Agent conversation surface populated from Release metadata;
- brokered `fs.search`, `fs.read`, and user-approved `fs.write`;
- local `evidence-review.md` whose bytes match the Artifact and Ledger digest;
- stable delivery and revenue recognition across idempotent retry.

Jordan never selects a Release or receives its private system prompt, Skill,
RAG, few-shots, synthetic QA, Evals, Factory paths, or Creator review material.

`../installable-desktop-v1.json` records the developer DMG build and mount
verification. It is ad-hoc signed and not notarized; it proves a buildable local
artifact, not frictionless public installation.

## Clean multi-Creator boundary

`release-portability.json` copies only the deployable Release packages into an
empty isolated root, then resolves and materializes both Maya's resume Agent and
Ari Cole's unrelated strength-planning Agent through the same Runtime code.
Both packages are self-contained, contain different Creator-specific payloads,
and have no dependency on their Factory work or review directories. Production
Factory, Runtime, Desktop, Dashboard, protocol, Registry, and Commerce code
contains no branch for either scenario.

## What this proof does not claim

- Creator distillation is an internal Codex workflow, not yet a self-serve
  Creator configuration UI.
- The V1 proof exercises the local tool envelope. Generic external capability
  bindings exist in the Release contract, but no third-party API adapter is
  claimed as live-tested here.
- The installed Desktop proof is a local UAT. The current packaged default
  Runtime endpoint is localhost; cloud hosting, production Registry signing,
  and macOS notarization are intentionally not claimed by this proof.
