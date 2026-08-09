#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

set -a
source "$ROOT/.env"
set +a

# The product Runtime, Registry, and Corpus storage are cloud-owned. This
# entrypoint starts only the Consumer Desktop; it never creates another Runtime
# or Registry that could diverge from the single Shanghai cloud environment.
cd "$ROOT/desktop-app"
npm run dev
