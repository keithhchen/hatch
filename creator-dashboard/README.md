# Hatch Creator Dashboard

The Dashboard is a product and commerce surface, not part of the Agent
construction pipeline. Its server reads one Dashboard-owned catalog snapshot;
it never reads a live Factory `work/` or `review/` directory.

## Import a product catalog

An internal, one-way import command converts one or more completed Factory
outputs into a clean catalog containing only public product metadata,
digest-pinned publish identity, and publication readiness. It omits Factory
paths, source traces, raw Evals, compiler artifacts, and internal release
validation detail.

```bash
npm run catalog:import -- \
  --factory-output /absolute/path/to/completed-factory-output \
  --output /var/lib/hatch/dashboard/product-catalog.json
```

Repeat `--factory-output` to import unrelated Creator products into the same
snapshot. Import is the only component that reads Factory output. The running
Dashboard receives only:

```bash
HATCH_CREATOR_PRODUCT_CATALOG_PATH=/var/lib/hatch/dashboard/product-catalog.json
HATCH_CREATOR_PRODUCT_STATE_PATH=/var/lib/hatch/dashboard/product-state.json
HATCH_REGISTRY_URL=http://127.0.0.1:8100
HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN=replace-with-a-shared-internal-secret
npm run api
```

The Factory owns Agent Corpus publication: run its `--publish` path with the
configured Registry service token. When an authenticated Creator publishes in
the Dashboard, the Dashboard verifies that the canonical TypeScript Registry
already lists the matching `(creator_id, product_id)` Agent before it records
the product's local published state. The Dashboard never writes a legacy
Release record or receives private Corpus material.

Publishing the same Dashboard product twice returns `409 already_published`
with the exact Release identity and original publication time. The second call
does not contact Registry or create commerce events. A different, newer Release
of the product remains separately publishable only after its own package,
Runtime, and same-digest comparison checks pass. Those are Hatch release gates,
not a Creator Human-in-the-loop review step.

## Connected Creator proof

The following run starts with a new Dashboard publication state, imports a
clean catalog, and reads the same append-only Ledger produced by the connected
Consumer delivery. Use three terminals, each initially at the repository root.

First create a fresh runtime directory and import the catalog. This is the only
step that reads the completed Factory output:

```bash
export HATCH_CREATOR_PROOF_DIR="$(mktemp -d)"
export HATCH_FACTORY_OUTPUT="/absolute/path/to/completed-factory-output"
export HATCH_EXPECTED_RELEASE_DIGEST="sha256:<expected-release-digest>"
test "$(find "$HATCH_FACTORY_OUTPUT/release" -name public.json -type f -exec jq -r .digest {} \;)" \
  = "$HATCH_EXPECTED_RELEASE_DIGEST"
cd creator-dashboard
npm run catalog:import -- \
  --factory-output "$HATCH_FACTORY_OUTPUT" \
  --output "$HATCH_CREATOR_PROOF_DIR/product-catalog.json"
```

Keep this first terminal open so its fresh runtime-directory variable remains
available for the Dashboard API command below.

Start the TypeScript Registry with its persistent state and Corpus root:

```bash
export HATCH_REGISTRY_STATE_PATH="$(mktemp -d)/registry-state.json"
export HATCH_FACTORY_OUTPUT="/absolute/path/to/completed-factory-output"
cd runtime-server
HATCH_AGENT_CORPUS_ROOT="$HATCH_CREATOR_PROOF_DIR/corpora" \
HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN=creator-proof-service-token \
HATCH_AUTH_SIGNING_SECRET=creator-proof-signing-secret \
npm run serve:registry
```

After Registry is listening, return to the first terminal, which is still in
`creator-dashboard`, and start the Dashboard API. It receives only the imported
catalog, a fresh state file, the connected Ledger, and Registry configuration:

```bash
HATCH_CREATOR_PRODUCT_CATALOG_PATH="$HATCH_CREATOR_PROOF_DIR/product-catalog.json" \
HATCH_CREATOR_PRODUCT_STATE_PATH="$HATCH_CREATOR_PROOF_DIR/product-state.json" \
HATCH_COMMERCE_LEDGER_PATH=../docs/proof/consumer-e2e-v1/commerce-ledger.jsonl \
HATCH_REGISTRY_URL=http://127.0.0.1:8100 \
HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN=creator-proof-service-token \
npm run api
```

Start the Creator UI:

```bash
cd creator-dashboard
HATCH_CREATOR_DASHBOARD_API_URL=http://127.0.0.1:8500 npm run dev
```

Sign in at `http://127.0.0.1:8510` with the local Creator fixture:

```text
maya@example.com
hatch-local-uat-creator
```

For an HTTP-level publish check, sign in and publish the product selected by
the authenticated Creator session:

```bash
CREATOR_TOKEN="$(curl --silent --show-error \
  --request POST http://127.0.0.1:8500/v1/auth/login \
  --header 'content-type: application/json' \
  --data '{"email":"maya@example.com","password":"hatch-local-uat-creator"}' \
  | jq --raw-output .token)"

curl --silent --show-error \
  --request POST \
  http://127.0.0.1:8500/v1/creator/products/signal-resume-review/publish \
  --header "authorization: Bearer $CREATOR_TOKEN" \
  | jq

curl --silent --show-error \
  http://127.0.0.1:8500/v1/creator/orders \
  --header "authorization: Bearer $CREATOR_TOKEN" \
  | jq

curl --silent --show-error \
  http://127.0.0.1:8500/v1/creator/payouts \
  --header "authorization: Bearer $CREATOR_TOKEN" \
  | jq
```

The expected connected projection is one delivered `$39.00` order, `$35.10`
available to the Creator, and `$3.90` Hatch share. Capture the UI in this
order: sign-in, ready-to-publish Home, published state, Orders, and Payouts.
A fresh `HATCH_CREATOR_PROOF_DIR` resets only Dashboard publication state; it
does not alter the shared Ledger.
