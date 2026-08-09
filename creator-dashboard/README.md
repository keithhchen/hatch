# Hatch Creator Dashboard

The Dashboard is a product and commerce surface, not part of Agent
construction or publication.

Its server has two sources of truth:

- TypeScript Registry: authenticated accounts and currently published Agent
  Corpus product metadata;
- Commerce Ledger: orders, entitlement delivery, revenue, and payouts.

There is no Dashboard-owned product catalog or publication state. The Factory
publishes a valid Corpus to Registry; once installed, the Dashboard reflects it
immediately by `creator_id + agent_id + corpus_digest`. Protected instructions,
Skills, knowledge, Evals, and Factory traces never enter Dashboard.

## Run locally

Start Registry first, then:

```bash
HATCH_REGISTRY_URL=http://127.0.0.1:8100 \
HATCH_COMMERCE_LEDGER_PATH=.local-uat/ledger.jsonl \
npm run api
```

In another terminal:

```bash
npm run dev
```

The UI is served by Vite on `http://127.0.0.1:8510`; the API defaults to
`http://127.0.0.1:8500`.

## Verify

```bash
npm test
npm run build
```

The API test covers Registry-backed Creator products and idempotent zero-value
checkout with an entitlement pinned to the current Agent Corpus digest.
