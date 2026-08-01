#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

set -a
source "$ROOT/.env"
set +a

cleanup() {
  jobs -p | xargs -r kill
}
trap cleanup EXIT

(cd "$ROOT/platform-registry" && uv run hatch-registry) &
(cd "$ROOT/runtime-server" && PORT=8400 npm run serve) &

sleep 2

cd "$ROOT/desktop-app"
npm run dev
