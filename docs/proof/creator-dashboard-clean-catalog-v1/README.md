# Creator Dashboard clean-catalog proof

Captured on 2026-07-31 from the Creator Dashboard connected to:

- a Dashboard-owned catalog imported from the completed Creator output;
- the same append-only Commerce Ledger used by the connected Consumer run;
- a fresh Registry configured with an internal publish service token;
- a fresh Dashboard-only publication state file.

`product-catalog.json` is the exact clean snapshot used for this run. A content
audit found none of `Factory`, `/work/`, `/review/`, `source_path`,
`trace_closure`, `expected_answer`, or `private.json` in that snapshot.

The running Dashboard process received no Factory output root and had no
`work/`, `review/`, or proof-directory dependency other than the explicit
shared Commerce Ledger. The one-way import completed before the Dashboard
server started.

## Verified identity and projection

```json
{
  "creator_id": "maya-chen",
  "product_id": "signal-resume-review",
  "release_id": "signal-resume-review@1.0.0",
  "release_digest": "sha256:d806cf915b29fa952e43ab4aaf02431cc39dfdde6a29b0d20509a07562eaaec5",
  "before_publish": "review_ready",
  "after_publish": "published",
  "orders": 1,
  "successful_deliveries": 1,
  "gross_minor": 3900,
  "creator_share_minor": 3510,
  "hatch_share_minor": 390,
  "payout_available_minor": 3510
}
```

Publishing returned HTTP 200 from Dashboard after Registry authenticated the
Bearer service token and verified that the Release belonged to the Creator ID
derived from the Dashboard session. A Buyer session received HTTP 403 from the
Creator product endpoint. `registry-publish.json` is the Registry record read
back after that publish.

## Screenshots

1. `01-login.png` — Creator-only sign-in.
2. `02-ready-revenue.png` — clean-catalog product ready for approval alongside
   revenue projected from the shared Ledger.
3. `03-release-approval.png` — Creator-facing checks and representative product
   behavior, without Factory paths or internal artifacts.
4. `04-behavior-review.png` — an expanded representative answer and its known
   limitation in Creator-facing language.
5. `04-published.png` — Registry-backed published state.
6. `05-orders.png` — Creator-scoped delivered order.
7. `06-payouts.png` — 90/10 revenue projection and available Creator balance.

Exact reproducible startup and HTTP commands are documented in
`creator-dashboard/README.md` under **Connected Creator proof**.
