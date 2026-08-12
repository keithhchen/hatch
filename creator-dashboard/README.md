# Hatch Creator Dashboard

The Dashboard is the web product, publication-workflow, and commerce surface.
Factory still constructs the Agent Corpus and Registry remains the authority
that verifies and installs its bytes.

Its server composes three deliberately separate sources of truth:

- TypeScript Registry: authenticated accounts, Factory runs, Agent Corpus
  verification/materialization, and current Runtime access;
- Portal state: checkout quotes, server-saved Factory drafts, candidate
  approvals, versioned offer drafts, releases, and public URLs;
- Commerce service: versioned offers, orders, payment facts, delivery-unit entitlements,
  deliveries, revenue, refunds, and payout read models.

Production requires `HATCH_COMMERCE_DATABASE_URL` and uses PostgreSQL as the
single Commerce writer with transactional outbox/inbox. Runtime sends
service-authenticated reserve/release/complete commands to the Dashboard BFF;
it never opens the production Commerce store directly. JSONL is supported only
for local development and isolated tests.

Browser sessions use same-origin `HttpOnly` cookies plus CSRF tokens. Runtime's
internal Commerce commands are not exposed by Caddy, and production containers
receive explicit environment allowlists instead of the shared server `.env`.

Protected instructions, Skills, knowledge, Evals, and Factory traces never
enter Portal or Commerce state. Public storefront projections contain only
client-safe product, Creator, offer, and release fields.

## Run locally

Start Registry first, then:

```bash
HATCH_REGISTRY_URL=http://127.0.0.1:8100 \
HATCH_REGISTRY_COMMERCE_SERVICE_TOKEN=replace-with-the-same-private-registry-token \
HATCH_COMMERCE_LEDGER_PATH=.local-uat/ledger.jsonl \
HATCH_PORTAL_STATE_PATH=.local-uat/portal-state.json \
HATCH_REGISTRY_ACCESS_SERVICE_TOKEN=local-access-service \
HATCH_REGISTRY_DEPLOYMENT_SERVICE_TOKEN=local-deployment-service \
HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN=local-runtime-commerce \
npm run api
```

In another terminal:

```bash
npm run dev
```

The UI is served by Vite on `http://127.0.0.1:8510`; the API defaults to
`http://127.0.0.1:8500`. Start at `/agents` for the public Buyer flow or
`/portal/creator` for an authenticated Creator.

Non-zero offers fail closed by default. `HATCH_COMMERCE_PAYMENT_MODE=test` is
available only for deterministic local tests. Production uses
`HATCH_COMMERCE_PAYMENT_MODE=provider` together with
`HATCH_PAYMENT_PROVIDER_BASE_URL`, `HATCH_PAYMENT_PROVIDER_API_TOKEN`, and
`HATCH_PAYMENT_PROVIDER_WEBHOOK_SECRET`; the bridge must return provider
payment/refund/payout references and send signed raw-body webhooks. A payment
intent creation response never grants access, even if it says `succeeded`;
only the signed payment webhook can atomically commit its provider inbox,
payment success, order, entitlement, outbox, and read models. Leave the mode
`disabled` until merchant, tax, region, refund, and payout policy is approved.
Production additionally refuses to start provider mode unless
`HATCH_COMMERCE_PAID_LAUNCH_APPROVED=true`; provider credentials alone never
constitute policy approval.
If paid fulfillment cannot project access, the reconciler retries for at least
`HATCH_FULFILLMENT_SLA_MS` (default five minutes) and
`HATCH_FULFILLMENT_MAX_ATTEMPTS` (default twelve attempts), then performs one
provider-confirmed compensating refund and exposes a durable refunded checkout
and receipt instead of leaving a captured payment pending forever.
Submitted payouts are queried through the provider adapter after
`HATCH_PAYOUT_RECONCILE_AFTER_MS` (default one minute); terminal provider state
is written through the same idempotent payout event contract, while query
failures retain retry count and the last safe error category for operations.
Public funnel ingestion is schema allowlisted and fixed-window rate limited;
`HATCH_ANALYTICS_RATE_LIMIT_PER_MINUTE` defaults to `120` per source address.

## Verify

```bash
npm test
npm run build
```

The commerce service token is shared only by Dashboard and Registry. User
bearers can read their access projection but cannot mint entitlements; checkout
first commits an order to the ledger, then calls the private Registry mutation.

The API test covers Registry-backed Creator products, fail-closed commerce
authentication, and idempotent zero-value checkout with an entitlement pinned
to the current Agent Corpus digest.
