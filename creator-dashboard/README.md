# Hatch Creator Dashboard

The Dashboard is the public web product, Creator publication workflow, and
authoritative free-access surface.
Factory still constructs the Agent Corpus and Registry remains the authority
that verifies and installs its bytes.

Its server composes three deliberately separate sources of truth:

- TypeScript Registry: authenticated accounts, Creator/Product catalog,
  Factory runs, Agent Corpus verification/materialization, and current release;
- Portal state: free-access sessions, server-saved Factory drafts, candidate
  approvals, releases, and public URLs;
- Access ledger (the package retains its historical `commerce` name): orders,
  delivery-unit entitlements, deliveries, and receipts.

Production requires `HATCH_COMMERCE_DATABASE_URL` and uses PostgreSQL as the
single Access writer with transactional outbox/inbox. Runtime sends
service-authenticated reserve/release/complete commands to the Dashboard BFF;
it never opens the production Commerce store directly. JSONL is supported only
for local development and isolated tests.

Browser sessions use same-origin `HttpOnly` cookies plus CSRF tokens. Runtime's
internal Access commands are not exposed by Caddy, and production containers
receive explicit environment allowlists instead of the shared server `.env`.

Protected instructions, Skills, knowledge, Evals, and Factory traces never
enter Portal or Access state. Public storefront projections contain only
client-safe Product, Creator, and release fields.

## Run locally

Start Registry first, then:

```bash
HATCH_REGISTRY_URL=http://127.0.0.1:8100 \
HATCH_COMMERCE_LEDGER_PATH=.local-uat/ledger.jsonl \
HATCH_PORTAL_STATE_PATH=.local-uat/portal-state.json \
HATCH_REGISTRY_DEPLOYMENT_SERVICE_TOKEN=local-deployment-service \
HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN=local-runtime-commerce \
npm run api
```

In another terminal:

```bash
npm run dev
```

The UI is served by Vite on `http://127.0.0.1:8510`; the API defaults to
`http://127.0.0.1:8500`. Start at `/explore` for public browsing or `/studio`
for an authenticated Creator.

Every published Product currently grants one free delivery. Production payment
mode stays `disabled`; paid access, pricing, subscriptions, refunds, and payouts
are outside the current product contract.
Public funnel ingestion is schema allowlisted and fixed-window rate limited;
`HATCH_ANALYTICS_RATE_LIMIT_PER_MINUTE` defaults to `120` per source address.

## Verify

```bash
npm test
npm run build
```

The internal Access service token is shared only by Dashboard and Runtime.
User bearers can read their own access but cannot mint entitlements. Registry
does not store or project ownership.

The API test covers Registry-backed Creator products, fail-closed Access
authentication, and idempotent zero-value checkout with an entitlement pinned
to the current Agent Corpus digest.
