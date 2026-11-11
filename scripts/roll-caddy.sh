#!/usr/bin/env bash
# Source this, set `compose` to the docker compose command (an array) that describes the release, then:
#   roll_caddy <caddy image> [caddyfile_dir] [env_file]
# Caddy owns host ports 80 and 443, so it cannot run twice the way roll_service does. A Caddyfile change is applied by
# `caddy reload`, which swaps the config in place without dropping a connection. The Caddyfile lives in a mounted
# directory (never a single-file mount: a replaced file gets a new inode the container would not see), so a reboot or
# `compose up` also starts from the current file. The new file is validated first; if validation or the reload fails,
# the old config keeps serving and this returns 1.
# The container is recreated (a brief gap on ports 80/443) only when it must be: it is missing, it has no mount of the
# directory yet (the first deploy of this scheme), or the release's image runs a different Caddy version.

roll_caddy() {
  local image="$1" dir="${2:-/opt/hatch/caddy}" env_file="${3:-/opt/hatch/.env}"
  local domain alias running mounted
  mkdir -p "$dir"
  dir="$(cd "$dir" && pwd -P)"
  docker run --rm --entrypoint cat "$image" /etc/caddy/Caddyfile > "$dir/Caddyfile.next" || return 1
  domain="$(sed -n 's/^HATCH_DOMAIN=//p' "$env_file" | tail -n 1)"
  alias="$(sed -n 's/^HATCH_DOMAIN_ALIAS=//p' "$env_file" | tail -n 1)"
  if ! docker run --rm -e HATCH_DOMAIN="$domain" -e HATCH_DOMAIN_ALIAS="${alias:-gethatchapp.com}" \
    -v "$dir/Caddyfile.next:/tmp/Caddyfile:ro" --entrypoint caddy "$image" \
    validate --config /tmp/Caddyfile --adapter caddyfile; then
    echo "caddy: the release's Caddyfile is invalid; keeping the running config" >&2
    rm -f "$dir/Caddyfile.next"
    return 1
  fi
  running="$(docker ps -q --filter label=com.docker.compose.project=hatch-app --filter label=com.docker.compose.service=caddy | head -n 1)"
  if test -n "$running"; then
    mounted="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy"}}{{.Source}}{{end}}{{end}}' "$running")"
  fi
  if test -n "$running" && test "$mounted" = "$dir" \
    && test "$(docker exec "$running" caddy version | cut -d' ' -f1)" = "$(docker run --rm --entrypoint caddy "$image" version | cut -d' ' -f1)"; then
    test ! -f "$dir/Caddyfile" || cp -f "$dir/Caddyfile" "$dir/Caddyfile.prev"
    mv -f "$dir/Caddyfile.next" "$dir/Caddyfile"
    if ! docker exec "$running" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
      echo "caddy: reload failed; restoring the previous Caddyfile (the running config was not changed)" >&2
      test ! -f "$dir/Caddyfile.prev" || mv -f "$dir/Caddyfile.prev" "$dir/Caddyfile"
      return 1
    fi
    return 0
  fi
  mv -f "$dir/Caddyfile.next" "$dir/Caddyfile"
  timeout 180s "${compose[@]}" up -d --no-deps --pull never --force-recreate caddy
}
