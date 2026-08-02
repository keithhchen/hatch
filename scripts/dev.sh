#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

set -a
source "$ROOT/.env"
set +a

# The product Runtime, Registry, and Corpus storage are cloud-owned. This
# entrypoint starts only the local Consumer Desktop; it never creates a local
# Runtime or local Registry that could silently diverge from production.
cd "$ROOT/desktop-app"
npm run dev
