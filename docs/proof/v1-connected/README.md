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
  -> sha256:9e0774372375f0caf1b132de259f0a2087e544d968cab3e8958945d68e7ee7a5
  -> order_connected_5c894980e9aa9c7c
  -> entitlement_connected_5c894980e9aa9c7c
  -> task_8d5ea9fc8cbfbf34016ad0f1
  -> artifact_8edafa77af41bd6c66661bf7
  -> sha256:a0041da45867819827a1b9d250e87298e1ba6ab1a39b773d060ecacedce1c019
  -> delivery_8edafa77af41bd6c66661bf7
  -> recognition_delivery_8edafa77af41bd6c66661bf7
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

The final Kimi-only blind comparison scores the Creator Agent at `1.0` and the
isolated generic baseline at `0.25`, a strict `+0.75` delta. The comparison is
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

`desktop-commerce-uat-2026-08-01.json` adds the final production-startup UAT:
an installed Tauri app runs the same digest through the ordinary Runtime entry
point, reads only a newly granted Jordan workspace, requests approval before
writing `desktop-commerce-final.md`, and then produces the exact Ledger and
Dashboard projection for that UI delivery. The proof is deliberately separate
from the restart/idempotency run above: one proves the installed Desktop path;
the other proves restart-safe delivery semantics.

## Clean multi-Creator boundary

`release-portability-2026-08-01.json` copies only the deployable Release packages into an
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
