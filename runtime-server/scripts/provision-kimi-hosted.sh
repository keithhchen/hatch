#!/bin/sh
# usage: SYSTEM_MD=<path to runtime/kimi-hosted/SYSTEM.md> scripts/provision-kimi-hosted.sh
# Env: KIMI_HOSTED_NAME_PREFIX (default hatch-site-audit). Keys are injected by agentsecrets and never printed.
cd "$(dirname "$0")/.."
exec agentsecrets exec --profile hatch --provider kimi -- \
 agentsecrets exec --profile hatch --provider pagespeed -- \
 agentsecrets exec --profile hatch --provider googlemaps -- \
 agentsecrets exec --profile hatch --provider cloudflare -- node scripts/provision-kimi-hosted.mjs "$@"
