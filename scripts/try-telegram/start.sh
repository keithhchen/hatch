#!/bin/bash
# Starts the local stack with every key it needs (Kimi, Gemini, Firecrawl), injected by agentsecrets. Extra env (e.g. NO_NGROK=1) passes through.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec agentsecrets exec --profile hatch --provider gemini -- \
  agentsecrets exec --profile hatch --provider kimi -- \
  agentsecrets exec --profile runtime-lab --provider firecrawl -- \
  node scripts/try-telegram/run.mjs "$@"
