# Hatch Platform Registry

FastAPI service for publishing and resolving verified Creator Agent Releases. It stores public publication records while the full immutable Release remains in the configured POSIX Release root. Published records can survive process restarts through a local JSON state file.

## API

- `GET /health`
- `POST /v1/creator/releases` (internal authenticated publish)
- `GET /v1/creator/{creator_id}/releases`
- `GET /v1/creator-releases/{release_id}`

Creator Release publishing fails closed unless
`HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN` is configured. Callers must send both:

```http
Authorization: Bearer <HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN>
X-Hatch-Creator-Id: <authenticated-creator-id>
```

Registry resolves the immutable Release and rejects the mutation unless its
public `creator_id` matches the authenticated Creator identity.
Once published, a `release_id` is permanently pinned to that digest. Any later
Release with different bytes must use a new versioned `release_id`; restarting
Registry never permits digest rebinding.

Set `HATCH_REGISTRY_STATE_PATH` to persist published Creator Releases. The
Registry reloads this file at startup and updates it with an atomic replace for
every new publication. When the variable is unset or empty, Creator Release
state remains process-local as before.

## Local Development

```bash
uv sync --extra dev
uv run pytest
HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN=replace-with-an-internal-secret \
  uv run uvicorn hatch_registry.app:app --reload
```

## Fresh-state publication boundary audit

Run the full authenticated publication boundary against a completed Factory
output without hand-writing a catalog or Registry record:

```bash
platform-registry/scripts/audit-fresh-publish-boundary.sh \
  /absolute/path/to/completed-factory-output \
  sha256:<expected-release-digest>
```

The script creates an empty temporary state directory, imports the Dashboard
catalog through its production importer, confirms the Registry returns `404`
before publication, signs in as the local Maya Creator profile, requires the
package/Runtime/comparison checks for the exact digest, and publishes through
the Dashboard API. It then restarts Registry with the same state file and calls
Runtime's `requirePublishedRelease` against the restarted process. Dashboard is
also restarted and signed into again; its published state must survive, while a
repeated publish must return `already_published` without another Registry
mutation. A passing run prints a JSON summary and leaves its detailed
request/response evidence in the reported temporary directory.

Both arguments are mandatory. Requiring the expected digest prevents an older
proof Release from silently becoming evidence for a newer publication audit.

This proves the V1 service boundary, not production identity infrastructure.
Creator login still uses the Dashboard's process-local demo session, while the
Registry publish endpoint trusts the configured internal service token to mean
that Dashboard has already enforced its same-digest quality gates. Registry
independently verifies Release bytes, digest, and Creator ownership; it does not
independently recompute Factory comparison evidence.
