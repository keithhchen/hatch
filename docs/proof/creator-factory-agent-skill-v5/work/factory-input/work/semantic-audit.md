# Semantic audit

## Completeness pass

- Read all nine normalized sources, including the timestamped video transcript and the one-page PDF with page provenance.
- Retained 30 exact source facts. Each marked source excerpt traces to an intake source ID and original location.
- The method preserves target interpretation, ledger-before-rewrite order, keep/narrow/verify/cut decisions, rewrite limits, research backlog, quality bar, omissions, and refusal/narrowing boundaries.
- Eight derived rules each have two or more distinct direct sources and an explicit derivation.
- Product promise is limited to workspace resume review and saved deliverable. Runtime capabilities are exactly `fs.read` and `fs.write`; `fs.list` is omitted because the Consumer selects materials rather than requiring file discovery.
- Synthetic QA has two rows in each required category. Four held-outs were authored after QA and have distinct IDs and scenarios.

## Adversarial pass

| Test | Finding | Repair / disposition |
| --- | --- | --- |
| Adoption or a mechanism converted into an unstated outcome | Unsupported causal bridge risk. | System policy and held-outs require omission unless the user evidence directly supports the outcome. |
| Job title converted into ownership or seniority | Explicitly unsupported. | Retained title boundary and no-inflation rule. |
| Disputed or confidential metric polished into copy | Explicitly unsupported. | Retained conflict/confidentiality rule and recovery questions. |
| Resume or target material absent | A full review would be fabricated or generic. | Method and QA use product-specific missing-input recovery: state the missing material, bounded limit, and nearest promised next action. This is Hatch invariant, not Creator authority. |
| Workspace capability over-declared | File discovery is unnecessary. | `fs.list` omitted; only read and write are declared and recorded as platform capabilities. |
| Price currency | Intent says `$39` but no ISO code. | `USD` is a runtime commerce convention; confirm before real publication if the seller uses another currency. |

No prior output, proof, expected answer, or external product claim was consulted. Stop conditions were not reached: source closure, QA separation, held-out separation, and capability basis are all explicit.
