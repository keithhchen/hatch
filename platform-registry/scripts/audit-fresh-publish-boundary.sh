#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 <completed-factory-output> <expected-release-digest>" >&2
  exit 64
fi
factory_output="$1"
expected_release_digest="$2"
if [[ ! "$expected_release_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Expected Release digest must be a full sha256 identity" >&2
  exit 64
fi
factory_output="$(cd "$factory_output" && pwd)"
audit_dir="$(mktemp -d /tmp/hatch-fresh-publish-audit.XXXXXX)"
service_token="fresh-publish-audit-token"
registry_pid=""
dashboard_pid=""
echo "Fresh-state audit evidence: $audit_dir" >&2

cleanup() {
  if [[ -n "$dashboard_pid" ]]; then
    kill "$dashboard_pid" 2>/dev/null || true
    wait "$dashboard_pid" 2>/dev/null || true
  fi
  if [[ -n "$registry_pid" ]]; then
    kill "$registry_pid" 2>/dev/null || true
    wait "$registry_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

free_port() {
  python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
}

wait_for_url() {
  local url="$1"
  local attempts=0
  until curl --silent --fail "$url" >/dev/null; do
    attempts=$((attempts + 1))
    if [[ "$attempts" -ge 100 ]]; then
      echo "Timed out waiting for $url" >&2
      return 1
    fi
    sleep 0.1
  done
}

start_registry() {
  (
    cd "$repo_root/platform-registry"
    HATCH_CREATOR_RELEASE_ROOT="$factory_output/release" \
    HATCH_REGISTRY_STATE_PATH="$audit_dir/registry-state.json" \
    HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN="$service_token" \
      uv run uvicorn hatch_registry.app:app \
        --host 127.0.0.1 \
        --port "$registry_port"
  ) >>"$audit_dir/registry.log" 2>&1 &
  registry_pid=$!
  wait_for_url "http://127.0.0.1:$registry_port/health"
}

start_dashboard() {
  (
    cd "$repo_root/creator-dashboard"
    HATCH_CREATOR_PRODUCT_CATALOG_PATH="$audit_dir/product-catalog.json" \
    HATCH_CREATOR_PRODUCT_STATE_PATH="$audit_dir/product-state.json" \
    HATCH_COMMERCE_LEDGER_PATH="$audit_dir/commerce-ledger.jsonl" \
    HATCH_REGISTRY_URL="http://127.0.0.1:$registry_port" \
    HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN="$service_token" \
    HATCH_CREATOR_DASHBOARD_API_PORT="$dashboard_port" \
      npm run api
  ) >>"$audit_dir/dashboard.log" 2>&1 &
  dashboard_pid=$!
  wait_for_url "http://127.0.0.1:$dashboard_port/healthz"
}

registry_port="$(free_port)"
dashboard_port="$(free_port)"
while [[ "$dashboard_port" == "$registry_port" ]]; do
  dashboard_port="$(free_port)"
done

cd "$repo_root/creator-dashboard"
npm run catalog:import -- \
  --factory-output "$factory_output" \
  --output "$audit_dir/product-catalog.json" \
  >"$audit_dir/catalog-import.log"

public_files="$(find "$factory_output/release" -type f -name public.json -print)"
if [[ -z "$public_files" || "$(printf '%s\n' "$public_files" | wc -l | tr -d ' ')" != "1" ]]; then
  echo "Audit requires exactly one immutable Creator Release under $factory_output/release" >&2
  exit 1
fi
public_json="$public_files"
creator_id="$(jq --raw-output .creator_id "$public_json")"
product_id="$(jq --raw-output .product_id "$public_json")"
release_id="$(jq --raw-output .release_id "$public_json")"
release_digest="$(jq --raw-output .digest "$public_json")"
if [[ "$release_digest" != "$expected_release_digest" ]]; then
  echo "Factory output digest $release_digest does not match expected $expected_release_digest" >&2
  exit 1
fi
encoded_release_id="$(jq --null-input --raw-output --arg value "$release_id" '$value|@uri')"
encoded_product_id="$(jq --null-input --raw-output --arg value "$product_id" '$value|@uri')"

if ! jq --exit-status \
  --arg creator_id "$creator_id" \
  --arg product_id "$product_id" \
  --arg release_id "$release_id" \
  --arg release_digest "$release_digest" \
  '.products
    | map(select(
        .creator_id == $creator_id
        and .product_id == $product_id
        and .release_id == $release_id
        and .release_digest == $release_digest
        and .publication.status == "ready"
      ))
    | length == 1' \
  "$audit_dir/product-catalog.json" >/dev/null; then
  echo "Exact Release is not publishable: package, Runtime, and same-digest comparison gates must all pass" >&2
  exit 1
fi

start_registry
before_status="$(curl --silent --output "$audit_dir/registry-before-publish.json" --write-out '%{http_code}' \
  "http://127.0.0.1:$registry_port/v1/creator-releases/$encoded_release_id")"
if [[ "$before_status" != "404" ]]; then
  echo "Fresh Registry unexpectedly resolved the Release before publication (HTTP $before_status)" >&2
  exit 1
fi

start_dashboard

curl --silent --show-error \
  --request POST "http://127.0.0.1:$dashboard_port/v1/auth/login" \
  --header 'content-type: application/json' \
  --data '{"email":"maya@example.com","password":"hatch-local-uat-creator"}' \
  >"$audit_dir/login.json"
creator_token="$(jq --raw-output .token "$audit_dir/login.json")"
jq --exit-status --arg creator_id "$creator_id" \
  '.profile.id == $creator_id and .profile.role == "creator" and (.token | length > 0)' \
  "$audit_dir/login.json" >/dev/null

curl --silent --show-error \
  "http://127.0.0.1:$dashboard_port/v1/creator/overview" \
  --header "authorization: Bearer $creator_token" \
  >"$audit_dir/dashboard-before-publish.json"
jq --exit-status \
  --arg release_id "$release_id" \
  --arg release_digest "$release_digest" \
  '.products
    | map(select(
        .status == "ready_to_publish"
        and .publication.status == "ready"
        and .release_id == $release_id
        and .release_digest == $release_digest
      ))
    | length == 1' \
  "$audit_dir/dashboard-before-publish.json" >/dev/null

publish_status="$(curl --silent --show-error \
  --output "$audit_dir/dashboard-publish.json" \
  --write-out '%{http_code}' \
  --request POST "http://127.0.0.1:$dashboard_port/v1/creator/products/$encoded_product_id/publish" \
  --header "authorization: Bearer $creator_token")"
if [[ "$publish_status" != "200" ]]; then
  echo "Dashboard publication failed (HTTP $publish_status)" >&2
  cat "$audit_dir/dashboard-publish.json" >&2
  exit 1
fi
jq --exit-status \
  --arg release_id "$release_id" \
  --arg release_digest "$release_digest" \
  '.product.status == "published"
    and .product.release_id == $release_id
    and .product.release_digest == $release_digest
    and .registry.release_id == $release_id
    and .registry.release_digest == $release_digest' \
  "$audit_dir/dashboard-publish.json" >/dev/null
published_at="$(jq --raw-output .registry.published_at "$audit_dir/dashboard-publish.json")"

kill "$registry_pid"
wait "$registry_pid" 2>/dev/null || true
registry_pid=""
start_registry
curl --silent --show-error \
  "http://127.0.0.1:$registry_port/v1/creator-releases/$encoded_release_id" \
  >"$audit_dir/registry-after-restart.json"
jq --exit-status \
  --arg creator_id "$creator_id" \
  --arg product_id "$product_id" \
  --arg release_id "$release_id" \
  --arg release_digest "$release_digest" \
  --arg published_at "$published_at" \
  '.status == "published"
    and .creator_id == $creator_id
    and .product_id == $product_id
    and .release_id == $release_id
    and .release_digest == $release_digest
    and .published_at == $published_at' \
  "$audit_dir/registry-after-restart.json" >/dev/null

kill "$dashboard_pid"
wait "$dashboard_pid" 2>/dev/null || true
dashboard_pid=""
start_dashboard
curl --silent --show-error \
  --request POST "http://127.0.0.1:$dashboard_port/v1/auth/login" \
  --header 'content-type: application/json' \
  --data '{"email":"maya@example.com","password":"hatch-local-uat-creator"}' \
  >"$audit_dir/login-after-restart.json"
restarted_creator_token="$(jq --raw-output .token "$audit_dir/login-after-restart.json")"
curl --silent --show-error \
  "http://127.0.0.1:$dashboard_port/v1/creator/overview" \
  --header "authorization: Bearer $restarted_creator_token" \
  >"$audit_dir/dashboard-after-restart.json"
jq --exit-status \
  --arg release_id "$release_id" \
  --arg release_digest "$release_digest" \
  --arg published_at "$published_at" \
  '.products
    | map(select(
        .status == "published"
        and .release_id == $release_id
        and .release_digest == $release_digest
        and .published_at == $published_at
      ))
    | length == 1' \
  "$audit_dir/dashboard-after-restart.json" >/dev/null

registry_posts_before_duplicate="$(grep -c 'POST /v1/creator/releases' "$audit_dir/registry.log" || true)"
duplicate_status="$(curl --silent --show-error \
  --output "$audit_dir/dashboard-duplicate-publish.json" \
  --write-out '%{http_code}' \
  --request POST "http://127.0.0.1:$dashboard_port/v1/creator/products/$encoded_product_id/publish" \
  --header "authorization: Bearer $restarted_creator_token")"
registry_posts_after_duplicate="$(grep -c 'POST /v1/creator/releases' "$audit_dir/registry.log" || true)"
if [[ "$duplicate_status" != "409" || "$registry_posts_before_duplicate" != "$registry_posts_after_duplicate" ]]; then
  echo "Repeated Dashboard publication was not an explicit, side-effect-free conflict" >&2
  exit 1
fi
jq --exit-status \
  --arg release_id "$release_id" \
  --arg release_digest "$release_digest" \
  --arg published_at "$published_at" \
  '.error.code == "already_published"
    and .error.release_id == $release_id
    and .error.release_digest == $release_digest
    and .error.published_at == $published_at' \
  "$audit_dir/dashboard-duplicate-publish.json" >/dev/null

cd "$repo_root/runtime-server"
npm run build >"$audit_dir/runtime-build.log"
REGISTRY_URL="http://127.0.0.1:$registry_port" \
PUBLIC_JSON="$public_json" \
RUNTIME_QUERY_OUTPUT="$audit_dir/runtime-exact-query.json" \
  node --input-type=module <<'NODE'
import { readFile, writeFile } from "node:fs/promises";
import { requirePublishedRelease } from "./dist/registryPublication.js";
const release = JSON.parse(await readFile(process.env.PUBLIC_JSON, "utf8"));
const publication = await requirePublishedRelease(process.env.REGISTRY_URL, release);
await writeFile(process.env.RUNTIME_QUERY_OUTPUT, `${JSON.stringify(publication, null, 2)}\n`, "utf8");
NODE

jq --null-input \
  --arg audit_dir "$audit_dir" \
  --arg creator_id "$creator_id" \
  --arg product_id "$product_id" \
  --arg release_id "$release_id" \
  --arg release_digest "$release_digest" \
  --arg published_at "$published_at" \
  '{
    passed: true,
    audit_dir: $audit_dir,
    checks: {
      creator_login: true,
      same_digest_publish_gate: true,
      fresh_registry_was_empty: true,
      dashboard_published_through_registry: true,
      registry_restart_preserved_publication: true,
      dashboard_restart_preserved_publication: true,
      duplicate_publish_is_explicit_and_side_effect_free: true,
      runtime_resolved_exact_digest: true
    },
    publication: {
      creator_id: $creator_id,
      product_id: $product_id,
      release_id: $release_id,
      release_digest: $release_digest,
      published_at: $published_at
    }
  }' | tee "$audit_dir/summary.json"
