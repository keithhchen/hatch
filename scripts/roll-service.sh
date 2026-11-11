#!/usr/bin/env bash
# Source this, set `compose` to the docker compose command (an array) that describes the release, then:
#   roll_service <service> [probe_function] [health_timeout_s] [stop_grace_s]
# Starts the release's container next to the running one, waits until it is healthy (and passes the optional
# probe, called with the container id), then stops the old one gracefully: it finishes its Runs and requests
# (HATCH_DRAIN_MS) while Caddy already sends new ones to the new container. A new container that never gets
# healthy is removed and the old one keeps serving.

roll_service() {
  local service="$1" probe="${2:-}" wait_s="${3:-180}" grace_s="${4:-120}"
  local filter=(--filter "label=com.docker.compose.project=hatch-app" --filter "label=com.docker.compose.service=$service")
  local old new count status waited=0
  old="$(docker ps -aq --no-trunc "${filter[@]}" | sort)"
  count="$(printf '%s' "$old" | grep -c . || true)"
  "${compose[@]}" up -d --no-deps --no-recreate --scale "$service=$((count + 1))" "$service" || return 1
  new="$(comm -13 <(printf '%s\n' "$old") <(docker ps -aq --no-trunc "${filter[@]}" | sort) | head -n 1)"
  test -n "$new" || { echo "$service: no new container was created" >&2; return 1; }
  while :; do
    status="$(docker inspect --format '{{if .State.Running}}{{.State.Health.Status}}{{else}}exited{{end}}' "$new")"
    if test "$status" = healthy && { test -z "$probe" || "$probe" "$new"; }; then break; fi
    if test "$status" = exited || test "$waited" -ge "$wait_s"; then
      echo "$service: new container is $status after ${waited}s; keeping the running one" >&2
      docker logs --tail 80 "$new" >&2 || true
      docker rm -f "$new" >/dev/null
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  if test -n "$old"; then
    # shellcheck disable=SC2086
    docker stop --time "$grace_s" $old >/dev/null
    # shellcheck disable=SC2086
    docker rm $old >/dev/null
  fi
  "${compose[@]}" up -d --no-deps --no-recreate --scale "$service=1" "$service"
}
