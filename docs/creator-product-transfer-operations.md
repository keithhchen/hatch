# Creator Product ownership transfer

This operation moves one published Product to a different Creator account. It
keeps the Product ID, Product content, buyer accounts, order and entitlement
IDs, payment facts, Runtime transcript contents, Factory conversation contents,
and historical Registry releases. It creates one immutable Registry release
bound to the target Creator, switches the live pointer, and moves each current
Product-scoped record that carries Creator authority.

## Supported command

Run the command in the Registry container. It accepts only the Product and
target account whose production audit is embedded in the command. `--check`
performs a read-only preflight and prints a privacy-filtered report.

```bash
docker exec hatch-app-registry-1 node scripts/transfer-creator-product.mjs \
  802f2105-e28e-4ddc-996a-0a97a7fa4bb5 tina@gethatchapp.com --check
```

The reviewed Product currently declares five MCP tools that use the account-
owned connection `nas_gateway_802f2105`. If the account owner explicitly
authorizes transferring that connection to Tina, first run a read-only
preflight with the opt-in flag:

```bash
docker exec hatch-app-registry-1 node scripts/transfer-creator-product.mjs \
  802f2105-e28e-4ddc-996a-0a97a7fa4bb5 tina@gethatchapp.com \
  --check --transfer-account-connections
```

That preflight must report no other current source Products using the
connection. With that authorization and a passing preflight, run:

```bash
docker exec hatch-app-registry-1 node scripts/transfer-creator-product.mjs \
  802f2105-e28e-4ddc-996a-0a97a7fa4bb5 tina@gethatchapp.com \
  --transfer-account-connections
```

The transfer changes only the connection's `tenant_id`; it preserves the
connection ID, kind, status, configuration, and secret. Tina receives the
connection's NAS access and the source Creator relinquishes its ownership. The
command never reads or prints the connection secret. Without the opt-in flag,
the preflight reports the account-owned connection as a blocker and performs
no writes.

The operation requires the Registry database, Creator object storage, shared
Runtime corpus directory, and Factory chat directory. After it completes,
refresh the Dashboard's in-memory Commerce and Portal views through the
authenticated operations endpoint from the Dashboard container:

```bash
docker exec hatch-app-dashboard-1 sh -lc 'curl --fail --silent --show-error \
  -H "Authorization: Bearer $HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN" \
  http://127.0.0.1:8500/v1/internal/commerce/operations >/dev/null'
```

It refuses to proceed if the audited counts, IDs, ownership bindings, active
Run state, event types, release pointer, Product Files, or Factory sessions have
changed.

## Transaction and recovery

The command prepares immutable Runtime and Registry release assets first. It
then takes the Commerce and Portal advisory locks, locks the affected tables,
revalidates the source state, and commits the Product, Registry, Commerce,
Portal, Runtime, Distillation, and explicitly authorized connection ownership
changes in one PostgreSQL transaction. It locks and rechecks current Product
tool declarations and source Product dependencies before moving a connection.
The Commerce event stream is replayed through `CommerceLedger`; changed event
payloads are rebuilt through its validator with the original event IDs,
idempotency keys, and timestamps. The same transaction updates their outbox
envelopes and invalidates the Commerce projection version for supported
recovery. The durable operation records a SHA-safe connection ownership
manifest for recovery and final verification.

Portal migration includes both checkout snapshots and the Creator Product
workflow record used when returning a buyer's purchase-time BriefSpec. Runtime
Conversation storage IDs are recomputed from the target Creator binding; public
Conversation IDs, buyer account IDs, Run IDs, event cursors, and transcript
payloads remain intact.

After the database commit, the command atomically renames both Factory session
directories and the Product-level `manual` directory. It checks the session
state and SHA-256 manifest before and after each move, without changing session
JSON, revision numbers, or manual file contents. The manual file contents are
treated as Product data; the transfer process hashes and moves them without
interpreting their text. A durable operation row records `database_committed`
before the file moves. If the process stops during that phase, rerunning the
command resumes from the recorded manifest and completes any remaining moves.
A completed operation is idempotent and verifies the final state.

Never update Commerce events, Portal state, Runtime JSONL files, Registry
release records, or Factory session files manually. Use this command so the
identity changes, projections, and audit record remain consistent.
