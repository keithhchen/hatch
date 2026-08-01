# Creator publishing and revenue proof

Verified on 2026-07-31.

## What is proved

- Dashboard discovers products from generic Factory output roots. No Creator,
  course, product, or proof path is defined in production Dashboard code.
- Factory-only gates cannot make a product publishable. Runtime results and a
  baseline comparison must both pass for the exact `release_id + digest`.
- Publish sends only `release_id + release_digest` to Registry. It does not
  create an order, entitlement, task, artifact, delivery, or revenue record.
- Registry resolves `public.json` and `private.json` from its configured Release
  root, recomputes the Release digest, verifies protected asset hashes, and
  rejects identity rebinding.
- Commerce has no scenario seed API. A generic `LedgerCommerceSink` recognizes
  revenue only after `delivery.completed`, with an idempotent 90/10 split.
- Buyer and Creator projections preserve the identity chain from Release through
  delivery and revenue recognition.

## Automated evidence

```text
Creator Dashboard: 6 tests passed
Creator Dashboard production build: passed
Commerce: 6 tests passed
Registry: 9 tests passed
git diff --check: passed
production decoupling grep: zero matches
production scenario-seed grep: zero matches
```

The Dashboard publish API test additionally asserts that the Commerce ledger
still contains exactly zero events immediately after a successful publish.

## Connected release result

The earlier incomplete Factory fixture still correctly remains at **Final
checks** and is useful as the negative publishing test. The connected proof now
also configures the completed Factory output at
`docs/proof/creator-factory-e2e-v1`, whose runtime and baseline evidence match
the exact Release digest. Maya can inspect actual held-out answers—including a
known limitation—then publish that immutable version. The Registry response,
product state, Ledger-backed order and 90/10 revenue projection, and screenshots
are recorded in `docs/proof/v1-connected/`.

## Generic local launch

Install the exact Factory Release under a Runtime/Registry release root, then:

```bash
cd platform-registry
HATCH_CREATOR_RELEASE_ROOT=/absolute/path/to/releases uv run hatch-registry

cd creator-dashboard
HATCH_CREATOR_FACTORY_OUTPUT_ROOTS=/absolute/path/to/factory-output \
HATCH_REGISTRY_URL=http://127.0.0.1:8100 \
npm run api

HATCH_CREATOR_DASHBOARD_API_URL=http://127.0.0.1:8500 npm run dev
```

For multiple Creator Agents, set `HATCH_CREATOR_FACTORY_OUTPUT_ROOTS` to a
path-delimiter-separated list. No source change is required.
