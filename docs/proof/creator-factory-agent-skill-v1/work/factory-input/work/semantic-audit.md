# Semantic audit

## Pass 1 — completeness self-audit

- Read all nine normalized documents: five text lessons/FAQ items, one video transcript, one PDF page, and two review examples.
- Retained 33 exact source facts with intake source IDs, original paths, and the PDF page or video timestamp range where applicable.
- Method includes target interpretation, ledger, decisions, rewrite order, deliverable, quality bar, deliberate omissions, and boundaries.
- Every derived rule has at least two direct source facts and an explicit derivation; no rule relies on uncited résumé-industry convention.
- Product promise is limited to reading the selected workspace, reviewing the supplied resume/target context, and saving a plan and rewrites there. Price is taken from the stated `$39` intent; no result guarantee was added.
- `tool_needs` distinguishes Factory-only deterministic intake from the live product. The live product declares exactly `fs.read` and `fs.write`; it needs no `fs.list`, runtime external tool, proprietary dataset, or prose-generation tool.
- Synthetic QA has two labelled rows in each of direct, composed, boundary, and out-of-scope categories. Held-outs were authored after QA and use distinct scenarios and IDs.

## Pass 2 — adversarial review and repairs

| Challenge | Finding | Repair / disposition |
| --- | --- | --- |
| Could adoption be converted into performance or efficiency? | This would exceed evidence. | Added explicit supported-signal and runtime-audit language; held-outs forbid turning checklist use into fulfillment or efficiency outcomes. |
| Could a title imply scope or results? | Explicitly prohibited by FAQ. | Added `D-NO-SCOPE-INFLATION`, product boundary, QA, and held-out checks. |
| Could conflicting values be silently selected? | Explicitly prohibited. | Added `D-CONFLICT-CONFIDENTIALITY`; QA and held-outs require a source-of-record question instead. |
| Could confidentiality be solved with a guessed range? | Explicitly prohibited. | Added the confidential-information boundary and a held-out forbidden behavior. |
| Could the Agent decide a job or inflate seniority? | Out of scope. | Included exact boundary support and nearest in-scope alternative. |
| Could the agent promise a hiring result? | Explicitly disclaimed. | Product boundary, QA, and public promise omit guarantees. |
| Could the agent read or save workspace material without declared capability? | The Desktop environment provides concrete local workspace capabilities. | Declared exactly `fs.read` to read user-selected resume/evidence and `fs.write` to save the review artifact; did not declare `fs.list` because the method does not need workspace discovery. |
| Is currency explicit? | The intent states `$39` but not an ISO currency code. | Used `USD` only as the conventional rendering required by the runtime price field; this is a commerce-metadata assumption, not a Creator claim. Confirm before real publication if the selling currency differs. |

## Outcome

No unsupported Creator biography, user-specific fact, invented tool, placement result, or prior-release material was used. The remaining currency convention is recorded above; all semantic resume-review behavior is grounded in the retained evidence. The compiler must recheck every retained excerpt against intake before a Release is produced.
