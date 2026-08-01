# Automated release gates

Overall: **PASS**

| Gate | Result | Evidence |
| --- | --- | --- |
| G01-source-trace | PASS | 42 source facts have exact excerpts and source paths |
| G02-derived-trace | PASS | 9 derived rules have derivations and source closures |
| G03-qa-separation | PASS | all four QA categories are non-empty and separated |
| G04-no-invented-authority | PASS | synthetic answers contain no invented Creator authority patterns |
| G05-no-guarantees | PASS | no positive synthetic answer guarantees an outcome |
| G06-method-fidelity | PASS | method preserves sequence, quality bar, omissions, and boundaries |
| G07-private-boundary | PASS | public Runtime manifest is generated from client-safe identity and offer fields only |
| G08-capability-policy | PASS | capabilities are within the local workspace envelope |
| G09-held-out-separation | PASS | 4 release evals are separate from synthetic QA/few-shots and define observable checks |
| G10-prompt-purification | PASS | system prompt is 5399 chars; compression ratio 0.4231522846618074; first-person Creator voice matches [] |
| G11-package-integrity | PASS | verified 4 private assets, Runtime digest, identity, and public/private boundary |
