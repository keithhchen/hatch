# Hatch Creator Dashboard

The Dashboard is the public web product, Creator publication workflow, and
Open Access surface: anyone chats with any live Agent.
Factory still constructs the Agent Corpus and Registry remains the authority
that verifies and installs its bytes.

Its server composes three deliberately separate sources of truth:

- TypeScript Registry: authenticated accounts, Creator/Product catalog,
  Factory runs, Agent Corpus verification/materialization, and current release;
- Portal state: server-saved Factory drafts, candidate
  approvals, releases, and public URLs;
- Access ledger (the package retains its historical `commerce` name): My
  library (the account's active free entitlements) and Creator earnings/payouts.

Production requires `HATCH_COMMERCE_DATABASE_URL` and uses PostgreSQL as the
single Access writer with transactional outbox/inbox. Runtime saves an Agent to
My library with a service-authenticated `POST /v1/internal/library/save` and
lists it with `GET /v1/internal/access/users/{id}/entitlements`; it never opens
the production Commerce store directly. JSONL is supported only
for local development and isolated tests.

Browser sessions use same-origin `HttpOnly` cookies plus CSRF tokens. Runtime's
internal Access commands are not exposed by Caddy, and production containers
receive explicit environment allowlists instead of the shared server `.env`.

Protected instructions, Skills, Evals, and Factory traces never
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
HATCH_GUEST_TOKEN_SECRET=local-guest-secret \
npm run api
```

In another terminal:

```bash
npm run dev
```

The UI is served by Vite on `http://127.0.0.1:8510`; the API defaults to
`http://127.0.0.1:8500`. Start at `/explore` for public browsing or `/studio`
for an authenticated Creator.

There is no purchase step: guests and accounts chat with any live Agent, and an
account's first Run saves the Agent to its library. The payment provider
(`HATCH_COMMERCE_PAYMENT_MODE`, default `disabled`) is used only for Creator
payouts.
Public funnel ingestion is schema allowlisted and fixed-window rate limited;
`HATCH_ANALYTICS_RATE_LIMIT_PER_MINUTE` defaults to `120` per source address.

## Verify

```bash
npm test
npm run build
```

The internal Access service token is shared only by Dashboard and Runtime.
User bearers can read and remove their own library but cannot mint entitlements. Registry
does not store or project ownership.

The API tests cover Registry-backed Creator products, fail-closed internal
authentication, and the idempotent library save/remove.
