# Consumer entitlement E2E proof

This proof exercises the existing Desktop + cloud Runtime architecture rather than a separate demo product:

1. The Desktop receives an explicitly injected authenticated session.
2. `GET /v1/me/creator-agents` returns only Creator Agent public metadata for that buyer's entitlements.
3. The Desktop opens the Runtime with `license_token + entitlement_id`; it never selects a Release id or digest.
4. The Runtime resolves Factory Release `signal-resume-review@1.0.0` at `sha256:d806cf915b29fa952e43ab4aaf02431cc39dfdde6a29b0d20509a07562eaaec5` server-side.
5. Protected Skill instructions, query-selected RAG context, and few-shot examples are materialized into the run.
6. Client-advertised local tools are intersected with the Release's public and private policies.
7. The Runtime brokers real `fs.search`, `fs.read`, and user-approved `fs.write` calls to the installed Tauri Desktop.
8. The written file is the delivery artifact: its byte digest equals the receipt and ledger `artifact_digest`.
9. Completion writes stable task/artifact/delivery events through `LedgerCommerceSink`, which automatically appends `revenue.recognized` (creator 3510 / Hatch 390 on a USD 39.00 order).
10. Replaying the same bound run short-circuits before model or tool execution, returns the existing delivery receipt, and leaves the local file byte-for-byte unchanged.

Evidence:

- `workflow-result.json`: file digest, stable delivery identity, retry invariants, and revenue split.
- `commerce-ledger.jsonl`: shared Ledger order → entitlement → task → artifact → delivery → revenue recognition chain.
- `runtime-portability.json`: the same Runtime resolves and materializes resume and fitness Releases without domain-specific branches.
- `workspace/`: the local workspace used by the harness.
- `screenshots/01-entitled-agent-library.png`: purchased-agent library and workspace grant.
- `screenshots/02-generic-creator-agent-chat.png`: blank, generic agent harness after Release binding.
- `screenshots/03-completed-local-delivery.png`: natural user request, real tool progress, approved local write, assistant result, and file delivery receipt.

Production-source decoupling audit:

```sh
rg -n -i 'maya chen|jordan lee|signal resume|resume review|ari|strength plan|fitness' \
  desktop-app/src/renderer runtime-server/src packages/protocol \
  --glob '!*.test.*' --glob '!**/dist/**'
```

The command returns no creator/domain constants in production Runtime/Desktop routing. Creator identity, product copy, and task boundaries come from immutable Release public metadata; proof identities remain in fixtures and evidence only.
