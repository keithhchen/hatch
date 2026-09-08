# Conversation history paging

Desktop opens a conversation by requesting `snapshot?view=page`. It receives
the most recent page of complete turns, relevant run states, conversation
metadata and a journal waterline captured before the history projection.
The initial response contains no historical journal payloads.

`history?limit=50&before_cursor=...` reads older turns. The opaque cursor binds
the conversation to the first persisted event of the oldest delivered turn.
Newly appended turns cannot shift that boundary. User/final assistant messages
count towards the page size; tools and skills remain attached to their turn.
Postgres selects page runs before loading their visible events. UI paging is
independent of model-context replay quotas and compaction.

`events?view=page&after_cursor=...&through_cursor=...&limit=100` supplies bounded
incremental journal pages. The response cursor acknowledges only delivered
events. Desktop validates ordering and run references without executing tool
effects, then reconciles a fresh latest-page projection. Already loaded older
messages and newer live updates are retained by stable message identity. If the
latest page does not overlap loaded history, recovery pages backward until it
reaches that prefix before advancing the cursor. An unchanged local running
partial is replaced by its durable final answer. A locally tracked run missing
from the latest page is read through the authorized run endpoint before its
recovery state is reconciled.

Historical tool cards contain metadata and a `detail_ref`. Their full authorized
input/output is fetched on expansion through `tools/:runId/:toolCallId`.
History pages contain attachment references, never inline binary payloads.
Image previews are fetched when visible; attachment access is checked against
the durable transcript, including references predating model compaction.

The unpaged snapshot route remains the explicit transport boundary for already
released Desktop clients during rollout. New Desktop clients request page mode
and do not fall back to unpaged history when paging fails.

Desktop shows preparation/loading while workspace, library, history or runtime
connection is pending. A failure exposes retry without clearing already loaded
messages. Older-page loading keeps the reader's scroll position and rejects
duplicate clicks and responses belonging to a previously selected conversation.

## Verification

Automated tests cover cursor scope, insertion between pages, complete turns,
stable identities, bounded journal recovery, tool/asset authorization, old assets
after compaction, renderer merges and loading states. A separate real Postgres
integration test uses `HATCH_TEST_DATABASE_URL` with an isolated test schema.
Production API checks and target OS UAT must be recorded separately from these
automated tests; passing fixtures alone does not establish Desktop UAT.

### Local verification — 2026-09-08

- Real PostgreSQL integration: 3 passed, using a temporary isolated cluster and
  per-test schemas. The CI Runtime job now runs these against PostgreSQL 16.
- Runtime full suite: 462 passed, 1 skipped, 1 unrelated local-data failure.
  `creatorFactorySourceScope.test.ts` expects the operator's local Madeline pack
  to contain 15 files; the existing directory contains 16. Neither the test nor
  the user's source pack was changed to hide this failure.
- Conversation HTTP tests: 9 passed, including pagination, invalid/cross-scope
  cursors and deferred large tool details.
- Desktop version/release helper tests: 19 passed; version sources are 0.1.27.
- Desktop renderer: 35 files / 258 tests passed; web build passed. Includes
  both actual recovery paths exercised with deferred HTTP test responses.
- Production API and installed macOS/Windows app UAT: pending deployment.
