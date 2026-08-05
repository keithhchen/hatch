# Research: Pi durable AgentHarness v2 mapped to Hatch

Status: non-normative research record. Pi 0.83.0 does not yet implement the
execution-bearing AgentHarness v2 methods, so this design is not the Hatch
implementation contract. It is retained only as a future reference.

Normative words `MUST`, `MUST NOT`, `SHOULD`, and `MAY` are used in their usual
requirements sense.

## 1. Decision

Hatch uses **Pi Core**, not Pi Coding Agent, as its agent-harness foundation.

The dependency boundary is:

```text
Cloud Runtime
  @earendil-works/pi-agent-core
  @earendil-works/pi-ai
  Hatch product adapters

Desktop
  Hatch UI
  Tauri workspace and approval authority
  Hatch Rust local tool executor
```

`@earendil-works/pi-coding-agent` MUST NOT be a Runtime dependency. It is a
read-only behavioral reference for proven coding-agent policies such as bounded
tool output and compaction behavior. Hatch does not adopt its CLI, local model
loop, local sessions, built-in coding product, or unrestricted local tool
assumptions.

The Pi design baseline is `badlogic/pi-mono` commit
`588915ec71714688cee8b7153339e8bdebb3e82e`, package version `0.83.0`, and in
particular `packages/agent/docs/harness-v2.md`. The commit is pinned because a
moving branch is not a specification.

At that baseline, the durable `AgentHarness v2` contract and public types exist,
but its execution implementation is not complete; several public methods still
throw `HarnessNotImplemented`. Hatch MUST therefore do one of the following
before production cutover:

1. consume a later, pinned Pi Core release that completes the v2 contract and
   passes the Pi Tier A/B/C suites; or
2. complete/vendor that exact Core contract and the same conformance suites in
   the Hatch-controlled dependency.

Using Pi Coding Agent as a shortcut is not an allowed third option.

All JavaScript and TypeScript dependency installation, tests, and builds use
`npm` and committed `package-lock.json` files. No production dependency may be
resolved from an unpinned Git branch. Hatch does not maintain npm, pnpm, and
yarn variants in parallel.

## 2. Authority and separation of concerns

Two specifications apply, at different layers:

- Pi defines harness mechanics: Session, tree, lanes, operations, records,
  effect boundaries, retries, recovery, tool call/result pairing, compaction,
  snapshots, events, hooks, and usage accounting.
- Hatch defines product meaning: account identity, orders, entitlements,
  immutable Agent Releases, protected Agent Corpus, Workspace grants,
  permissions, RAG, delivery audit, Artifacts, Deliveries, and the Ledger.

Hatch MUST NOT invent a second agent lifecycle beside Pi. Pi MUST NOT become a
source of Hatch commerce, entitlement, privacy, or product semantics.

The existing [Hatch v1 execution contract](./spec-v1-execution-contract.md)
remains authoritative for product behavior. When a mechanism in this document
and a product outcome appear to conflict, the implementation MUST preserve the
Hatch outcome using a Pi-compatible adapter; it MUST NOT weaken either contract
silently.

## 3. Product outcome

The Runtime is complete only when this real journey works:

```text
Creator publishes immutable Agent Release
                       ↓
Website browse → order → entitlement
                       ↓
Desktop login → entitled Agent → Workspace and permissions
                       ↓
Cloud Pi Runtime → server RAG/reasoning → approved local tools
                       ↓
audited final text/file → local Artifact → Delivery and Ledger receipt
```

A successful HTTP response, model completion, tool call, or file write is not
by itself a successful product outcome. A run succeeds only when the promised
result is usable and, when a file was requested, the local file and its digest
have been acknowledged and linked to a durable Delivery.

## 4. Product concepts mapped to Pi

| Hatch concept | Pi concept | Rule |
|---|---|---|
| Conversation | Session | One durable server-side Session bound to one account and immutable Agent Release. |
| Normal chat branch | `main` lane | Hatch v1 exposes one lane and does not show lane terminology in Desktop. |
| User request | Run operation | Acceptance creates the Pi `operation_started` record. Retries are steps, not new runs. |
| Model response plus its complete tool batch | Turn | Internal execution unit; not presented as a separate product object. |
| Provider attempt, compaction, or branch summary | Step | Retry count is durable across process restarts. |
| Product Task | Business record linked to a run | In v1, an accepted new user request creates one Task and one Pi run. |
| Stop button | Pi `abort()` | The durable outcome is `aborted`; “Stopped” is the user-facing label. |
| Agent tool | `AgentTool` | Server or remote-local adapter; every effect obeys Pi intent/result ordering. |
| Workspace/permission change | deferred configuration/custom entry | Accepted durably and applied at the next Pi checkpoint. |
| Long conversation checkpoint | `CompactionEntry` | Full history remains durable; only provider context is compacted. |
| Child agent, if introduced | deterministic fork or lane | Child identity derives from parent Session and tool invocation; never an untracked chat completion. |

Account, entitlement, Release digest, Task, Artifact, Delivery, and Ledger rows
are application control-plane data. They are not Pi conversation entries and
MUST NOT enter model context merely because they are persisted.

## 5. Ownership boundary

### 5.1 Cloud Runtime owns

- Pi `AgentHarness`, Session, lane, operation, turn, and step lifecycle
- all provider calls and Kimi streaming
- thinking policy and model configuration
- durable conversation tree and operation records
- context projection and compaction
- protected Release system instructions and Skills
- Qdrant retrieval and all private Agent Corpus materialization
- server tools and external Creator connections
- tool scheduling and replay decisions
- delivery claim audit, revision, Artifact/Delivery orchestration, and usage
  accounting
- snapshot construction, automatic restore, and live events

### 5.2 Desktop owns

- login UI and entitled-Agent selection UI
- native Workspace grant and native persistence of that grant
- permission and Shell access controls
- explicit approval UI
- execution of `fs.*`, `shell.exec`, and `git.*` inside the granted Workspace
- local containment checks, bounded tool outputs, cancellation, and durable
  idempotency receipts for local effects
- display of the client-safe Session snapshot and live events

Desktop MUST NOT own or reconstruct the agent loop, LLM messages, context
window, compaction, RAG, Release system prompt, private Skills, delivery audit,
or conversation truth.

The trusted local boundary includes grant enforcement, user approval, and tool
execution. “Local only does tool execution” means no reasoning or private Agent
runtime moves local; it does not remove the local UI needed to authorize those
effects.

### 5.3 Registry and Dashboard own

- Registry owns Creator identity, Agent identity, immutable Release versions,
  publication state, client-safe metadata, server-private Release references,
  and entitlements.
- Commerce owns orders and the append-only Ledger.
- Dashboard projects Creator products, orders, Deliveries, revenue, and
  aggregate Runtime health. It MUST NOT receive raw buyer prompts, local file
  contents, private Release assets, or reasoning traces.

## 6. Session identity and Release binding

One Hatch Conversation maps to one Pi Session and MUST be bound server-side to:

```text
account_id
entitlement_id
creator_id
agent_id
release_id
release_digest
```

The Desktop supplies only an authenticated account token, `entitlement_id`, and
`conversation_id`. Registry resolves every other binding. Client-selected
`creator_id`, `product_id`, `agent_id`, `release_id`, and `release_digest` are
not trusted selectors in the new protocol.

At Session creation, Runtime MUST:

1. authenticate the account;
2. resolve an active entitlement;
3. resolve one published immutable Release and its private half by matching
   digest;
4. persist the binding in application Session metadata;
5. initialize the Pi model, thinking level, and active-tool entries; and
6. create `main` at the empty leaf.

Every new run revalidates account access and entitlement before acceptance. A
normal entitlement expiry or revocation prevents new runs but does not erase an
already accepted paid Task. An explicit security revocation MAY durably abort
an active run.

Selecting another Agent selects or creates a different Conversation/Session.
An existing Session never changes its Agent Release in place. Publishing a new
Release does not silently upgrade an active Session.

## 7. Exact Pi durability model

Production Session state has the same four Pi parts:

1. append-only conversation tree;
2. permanent named lanes and their leaves;
3. per-lane append-only operation records; and
4. append-only latest-wins global facts.

Every write shares one monotonic Session `seq`. Operation records never enter
the conversation tree, provider context, transcript, fork, or Desktop history.

The non-negotiable effect rule is:

> Before an effect, persist an intent that provisions its result identity.
> After the effect, append the result under that identity.

This applies equally to Kimi requests, server tools, remote Desktop tools,
compaction, delivery audit model calls, and delivery writes. An intent without
a result is completed, retried, or closed with a synthetic result according to
its declared policy. A result without a corresponding accepted intent is
invalid.

The following Pi records remain canonical and MUST NOT be replaced by a second
Hatch run-state log:

```text
operation_started
abort_requested
operation_finished
step_attempt
tool_started
queue_enqueued
queue_cancelled
write_deferred
usage
```

Hatch business events may reference these IDs but do not substitute for them.

### 7.1 Single writer

Exactly one harness writes a Session. A production serving layer holds a
fenced, expiring lease keyed by `session_id` and routes all lane traffic to that
owner. A second open operation on one lane is corruption, not concurrency.

All lane state-dependent decisions use Pi's per-lane mutation line: validate,
perform at most one durable write, then update in-memory state. Provider calls,
Desktop calls, hooks, audit calls, and backoff MUST NOT execute while holding
that line.

### 7.2 Accepted input

The client sends an idempotent `client_message_id`; it does not choose the Pi
`run_id`. Runtime accepts the request by writing `operation_started`, whose ID
becomes `run_id`, and then acknowledges `run.accepted`. Repeating the same
`client_message_id` returns the same acceptance result and MUST NOT create a
second Task, run, charge, or Delivery.

### 7.3 Partial streams

Provider stream fragments are live UI events, not durable conversation
entries. A complete assistant response is appended only after the provider
step settles. If the process dies mid-stream, recovery retries or closes the
step according to Pi; it never presents a partial fragment as the durable final
answer.

## 8. Postgres SessionStorage

Production uses a Postgres implementation of Pi's backend-neutral
`SessionStorage`; JSONL and memory are test/development backends only. The
Postgres adapter MUST preserve Pi semantics, including:

- atomic append-and-lane-advance for entries;
- one shared monotonic sequence for entries, records, facts, and lane moves;
- immutable JSON-serializable payloads;
- provisioned-ID uniqueness;
- indexed `findOpenOperations(lane, { limit: 2 })`;
- bounded record scans from an open operation;
- bounded branch scans from a leaf to the latest compaction;
- O(1) projected usage totals; and
- a fenced single-writer lease.

The minimum storage objects are equivalent to:

```text
agent_sessions
agent_session_sequences
agent_entries
agent_records
agent_lanes
agent_lane_moves
agent_facts
agent_session_leases
agent_session_usage_totals
```

Task, Artifact, Delivery, Order, and Ledger storage remains in their product
tables. Each stores the Pi `session_id` and `run_id` needed for traceability.

Runtime MUST NOT use the current process-local pending-call map or local JSONL
event file as production recovery state.

### 8.1 Canonical chat history

The Pi Session is the only canonical chat-history store. Hatch MUST NOT persist
a second flattened `message.created` conversation or reconstruct model context
from a UI event log.

The server-private canonical branch contains:

- committed conversational messages, including consumed steering and
  follow-ups, with their real origin retained;
- complete assistant messages, including provider metadata and tool calls;
- paired tool-result messages;
- compaction and branch-summary entries;
- model, thinking-level, and active-tool changes; and
- explicitly projected custom entries such as a Workspace capability change.

Pi operation records are stored durably beside the tree but are not chat
history. Provider deltas and status copy are live-only and are never appended as
messages. A provider response becomes history only when its complete assistant
entry commits.

Compaction does not remove visible history. Model-context queries stop at the
newest compaction entry; UI-history queries walk the complete branch from its
captured leaf toward the root. These are deliberately different queries over
the same canonical tree.

Reasoning/thinking content MAY be retained server-private when the provider
adapter requires it for correct continuation, but it is never part of the
client projection.

### 8.2 Stable identity and grouping

Every UI object is derived from stable Pi identities:

```text
session_id       Pi Session
lane             main
entry_id         committed tree entry
run_id           operation_started record id
turn_id          assistant result entry id
tool_call_id     model tool-call identity
effect_id        provisioned tool-result entry id
client_message_id client idempotency identity
```

Postgres maintains a derived, rebuildable entry-reference index from operation
records so a bounded branch query can resolve `entry_id -> run_id` without a
historical log scan. It indexes initial-message provisioned IDs, step result
IDs, tool result IDs, queued/deferred target IDs, and their run/tool identities.
The index is not a second source of truth; corruption or loss is repaired from
the append-only records.

One Pi run may contain several assistant turns and tool-result entries. Hatch
projects those entries into one user-facing assistant work item keyed by
`assistant:<run_id>`. Tool calls, approvals, Skills, diffs, and Delivery become
ordered parts inside that item. They do not appear as separate `tool` chat
messages. Only account-authored input carrying a `client_message_id` is
projected as a user item. Runtime follow-ups, delivery enforcement, recovery
messages, and other server-authored `user`-role context MUST NOT be attributed
to the user; they project to a safe activity/status part or remain hidden.

Hatch v1 accepts one account-authored message on `main` while no run is active;
the composer becomes Stop while it runs. Pi steering/follow-up queues remain
available to server orchestration, but Desktop does not expose conversational
steering in projection version 1. If user-authored mid-run steering is added
later, it requires an explicit DTO/order rule and projection-version update.

This grouping preserves the simple product model—one request followed by one
piece of work—without altering or flattening the canonical Pi transcript used
for recovery and model context.

### 8.3 Client-safe projection

`ConversationProjector` is a pure, versioned server module. Its input is a
bounded Pi branch slice, the derived entry/run references, the current
`LaneSnapshot`, and client-safe Delivery metadata. Its output contains no Pi
types or private Release payloads.

The wire DTO is conceptually:

```ts
type ConversationItem =
  | {
      id: `user:${string}`;
      kind: "user";
      entry_id: string;
      run_id: string;
      created_at: number;
      text: string;
    }
  | {
      id: `assistant:${string}`;
      kind: "assistant";
      run_id: string;
      status: "running" | "waiting_for_approval" | "completed" | "failed" | "aborted";
      created_at: number;
      parts: ConversationPart[];
      delivery?: ClientSafeDelivery;
    };

type ConversationPart =
  | { id: string; type: "text"; text: string; state: "streaming" | "committed" }
  | { id: string; type: "status"; label: string; active: boolean }
  | {
      id: string;
      type: "tool_activity";
      tool_call_id: string;
      label: string;
      locality: "server" | "client";
      status: "requested" | "waiting_for_approval" | "running" | "completed" | "failed" | "aborted";
      target?: string;
      approval?: "not_required" | "pending" | "approved" | "denied";
      diff_preview?: string;
      error?: { code: string; message: string };
    }
  | { id: string; type: "skill_activity"; label: string; status: string }
  | { id: string; type: "delivery"; delivery: ClientSafeDelivery };
```

The exact JSON Schema lives in `packages/protocol`; Desktop consumes generated
types. The React app MUST NOT reinterpret raw Pi entries or join tool events to
messages itself.

Projection rules are allowlist-based:

- user and committed user-visible assistant text may pass;
- reasoning/thinking blocks never pass;
- system instructions, Skill contents, RAG private references, compaction
  summaries, and branch summaries never pass;
- tool calls are reduced to a product label, relative target, approval/status,
  safe diff preview, and safe error;
- raw tool arguments/results, absolute paths, shell environment, auth data, and
  provider payloads never pass;
- `hatch.file_search` may be shown as “Searched this Agent's knowledge”, never
  with Qdrant IDs or protected excerpts; and
- Delivery exposes only its user-owned Artifact path/name, digest, and status.

Every projector output carries `projection_version: 1`. A projection version
change is a protocol change and requires snapshot golden tests.

### 8.4 Snapshot without a history/event gap

Opening or reconnecting a Conversation follows Pi's watch contract exactly:

1. call `lane.watch()`; Pi atomically captures `LaneSnapshot` and starts
   buffering live events;
2. take the captured `leafId` and query the newest visible branch page ending
   at that exact leaf;
3. project that page together with `streamingMessage`, `runningTools`, pending
   approval, capability generation, and Delivery state;
4. send one complete `conversation.snapshot`; and
5. only after the snapshot is on the wire, call `start(listener)` to flush the
   buffered events in order and continue live.

The snapshot shape includes:

```text
projection_version
session_id / conversation_id / lane / leaf_id
agent public identity and immutable release identity
items[]
older_page_cursor?
active_run?
capability_generation
```

`active_run` contains the server-issued run ID, start time, projected status,
safe provisional assistant text when the process is still alive, running local
tools, approval state, and Delivery progress.

If only the WebSocket died, the living harness snapshot can include the current
streaming message. If the Runtime process died, Pi has no durable partial
stream; the fresh snapshot removes that provisional text and shows the durable
suspended/restoring operation. Desktop always replaces its ephemeral state
with the new snapshot instead of attempting to merge two speculative streams.

### 8.5 Pagination and conversation list

The first snapshot contains the newest 50 projected items by default. Older
history is loaded through:

```text
GET /v1/conversations/:conversation_id/items?before=:cursor&limit=50
```

The opaque signed cursor is bound to account, Session, lane, captured branch
leaf, projection version, and oldest returned entry. It cannot be reused to
read another buyer, Agent, or branch. Pagination walks canonical branch
parentage, not timestamps, so concurrent appends cannot move or duplicate an
older page.

Conversation inventory is loaded separately:

```text
GET /v1/conversations?entitlement_id=:id
```

Each row contains only Conversation ID, Pi Session name, client-safe Agent
identity, last visible activity time, last-delivery status, and whether an
operation is active. The Session name is Pi's latest-wins global fact; preview
copy is generated from already client-visible text and never from private tool
or reasoning content.

### 8.6 Live UI reducer

After the snapshot, Desktop applies client-safe live projection events as
idempotent upserts:

- local send creates a temporary user item keyed by `client_message_id`;
- `run.accepted` replaces it with the committed `entry_id` and server-issued
  `run_id`;
- `assistant.delta` mutates only the ephemeral text part of
  `assistant:<run_id>`;
- projected tool start/update/end events upsert one part by `tool_call_id`;
- committed `message_end` replaces the corresponding ephemeral part with the
  server-projected committed value;
- `delivery.ready` upserts the Delivery part; and
- `run.completed`, `run.failed`, or `run.aborted` sets the assistant work
  item's terminal state.

The reducer never appends blindly. Stable IDs make repeated events, a snapshot
followed by buffered events, and local optimistic state converge without
duplicate bubbles or tool cards.

On reconnect, Desktop discards the old live reducer state for that Conversation
and installs the new snapshot before accepting events. Browser/Tauri local
storage is not chat-history authority; it may retain only harmless UI
preferences and an unsent draft.

### 8.7 Projection implementation rule

The initial implementation projects directly from indexed Postgres Session
queries. It does not persist a second flattened history table. A materialized
cache MAY be added later only if it is keyed by canonical IDs and projection
version, can be rebuilt completely, and is never used for recovery or model
context.

The current `RuntimeStore.readVisibleConversation()` and Desktop
`historyMessageToThreadMessage()` split projection are removed. Server tests
own golden fixtures for redaction, run grouping, tool pairing, pagination,
compaction-crossing history, mid-stream snapshot, process-restart snapshot, and
cross-account isolation. Desktop tests only rendering and live-reducer
convergence against the protocol DTO.

## 9. Run lifecycle and recovery

Pi operation outcomes remain:

```text
completed | failed | aborted | suspended
```

`declined` also applies to standalone structural operations. User-facing
progress such as “waiting for approval”, “using your Workspace”, and “keeping
context ready” is a projection of a running operation, not a competing state
machine.

At Runtime startup, `AgentHarness.create()` restores all lanes and starts no
effects. The serving layer then rebinds model, tool, Release, and Desktop
capabilities. Once identities are present, it automatically calls `resume()`
for recoverable open work. The user is never asked to press “Reconnect”.

Recovery follows Pi exactly:

- missing accepted input is appended;
- unfinished provider steps resume with the durable next attempt number;
- a pending Desktop tool call is reconciled using its persisted
  `tool_started` record and replay declaration;
- a provider deferred handle is fetched rather than replaced;
- terminal error entries cannot be recovered as success;
- abort inserts synthetic results for unresolved calls and a closing assistant
  entry; and
- every recovery append skips an already fulfilled provisioned ID and verifies
  that existing content matches.

After a resume settles, Runtime recomputes the record reduction and compares it
with live lane state. A mismatch faults the Session rather than continuing from
ambiguous state.

## 10. Kimi provider contract

Hatch v1 uses only `kimi-k2.6` through an official Moonshot endpoint for:

- normal assistant steps;
- compaction and branch summaries;
- delivery claim review and revision;
- Factory/UAT roles governed by the existing Hatch v1 contract.

The Pi `Models` adapter receives the credential explicitly from
`LLM_API_KEY`; Hatch does not rename the deployment secret to a provider brand,
and it does not depend on Pi's default `MOONSHOT_API_KEY` environment lookup.
The key never enters Session entries, records, events, Releases, Desktop, proof
screenshots, or telemetry.

Thinking is enabled for every model-mediated role, including compaction and
delivery audit. The Pi lane thinking level MUST be non-`off`, and the Moonshot
adapter MUST emit the provider's enabled-thinking payload. Desktop does not
offer a model or thinking toggle in v1.

Thinking is not disabled as a remedy for context or delivery problems. Pi
usage accounting records reasoning tokens. A `length` response is classified
against the intended output cap, including reasoning usage, exactly as Pi
specifies:

- reaching the intended cap is a genuine output-limit stop;
- stopping below it under context pressure is recoverable once through
  compaction; and
- a second recoverable overflow before new conversational input fails
  boundedly.

There is no provider fallback and no mixed-model evidence. A misconfigured
model, endpoint, thinking mode, or credential fails closed at startup.

## 11. Context is a projection, not history

The durable Session tree is not copied wholesale into each model request. The
Runtime builds provider context through Pi's branch query,
`transform_context`, entry projectors, and `toProviderMessages`.

The request context, in order, is:

1. Hatch platform safety and delivery invariants;
2. the private immutable Release system instructions;
3. the current client-safe Workspace capability description (never its
   absolute root);
4. the active protected Skill instructions and references needed for this
   step;
5. the latest Pi compaction checkpoint and its retained tail, or the current
   uncompacted branch;
6. bounded RAG/tool evidence already represented by paired assistant tool calls
   and tool results; and
7. queued steering or follow-up input consumed at the current checkpoint.

The following MUST NOT enter provider context:

- Pi operation records, retries, leases, UI events, approval widgets, or
  telemetry;
- auth tokens, absolute Workspace roots, connection credentials, or Registry
  private references;
- Factory traces, Evals, expected answers, rejected material, or Creator
  revenue;
- duplicate copies of tool output; or
- the current implementation's synthetic `auditMessages`,
  `productToolEvidence`, or evidence-handoff transcript.

Assistant tool-call messages and their tool-result messages remain a valid,
ordered pair. Runtime MUST NOT solve context pressure by dropping arbitrary
tool messages or flattening an entire tool history into a growing user message.

Changing Workspace marks prior evidence with its old grant generation. The
projector excludes that evidence from claims about the new Workspace unless the
user explicitly asks to compare the two. This prevents evidence from two local
folders being silently treated as one.

## 12. Pi compaction contract

Compaction runs only in Cloud Runtime and uses Pi Core's compaction semantics.
Initial settings are Pi's defaults:

```text
enabled            true
reserveTokens      16384
keepRecentTokens   20000
threshold          contextTokens > contextWindow - reserveTokens
```

The settings are server policy, not a Desktop control. They may change only
with measured eval evidence and a versioned Runtime configuration.

Compaction MUST:

- occur at a Pi checkpoint before the next request when the threshold is
  crossed;
- support one reactive overflow compaction per newest conversational input;
- append a `CompactionEntry` containing `summary`, complete `retainedTail`,
  `tokensBefore`, details, and usage;
- retain approximately the configured recent-token budget;
- update a prior structured summary rather than discard it;
- never cut at a tool-result entry or break a call/result pair;
- summarize split-turn history separately when required;
- omit system/Release material that is injected afresh per request;
- cap each serialized tool result used by the summarizer to 2,000 characters;
- preserve read/modified artifact metadata needed to continue; and
- record usage for every successful, failed, retried, or discarded provider
  request before classifying its outcome.

The durable tree is never rewritten or replaced by `replacement_history`.
Provider context reads the newest compaction entry, its materialized retained
tail, and later entries; older history remains queryable and visible through
pagination.

Pinned Creator Agents are not exempt from compaction. The current behavior that
skips mid-turn compaction for a pinned Creator Release is forbidden.

## 13. RAG and protected Agent Corpus

Agent Corpus is materialized only in Cloud Runtime. Registry binds
`creator_id + agent_id + release_digest` to an isolated Qdrant knowledge space.
Neither Release public metadata nor Desktop receives Qdrant collection IDs,
private paths, prompts, Skills, or source documents.

`hatch.file_search` is a server `AgentTool` with replay `safe`. It returns a
bounded evidence set containing:

- a server-private evidence reference;
- the minimum relevant excerpt;
- source/provenance information allowed by the Release; and
- retrieval score and truncation metadata in non-user-facing details.

Retrieval results enter the Pi tree once as the result paired with their tool
call. They are not copied into a second evidence transcript. Delivery audit may
resolve the evidence references server-side but MUST receive only the relevant
claim batch, product promise/boundaries, and the evidence required for that
batch.

## 14. Remote local tools

Cloud Runtime represents each available Desktop capability as a Pi
`AgentTool`. The tool's `execute()` implementation is a remote adapter to the
currently bound Desktop connection. Pi still owns preparation, validation,
`tool_started`, finalization, result entry, retries, abort, and recovery.

Canonical local capabilities are:

```text
fs.list
fs.search
fs.read
fs.write
fs.patch
shell.exec
git.diff
tool_output.read
```

`tool_output.read` reads another bounded page from an opaque local result spool;
it does not grant arbitrary filesystem access.

For every remote-local call, Runtime MUST:

1. validate arguments and run `before_tool`;
2. provision a result entry ID;
3. append `tool_started` with effective arguments and replay policy;
4. send a request containing the provisioned ID as `effect_id`;
5. await a bounded, correlated Desktop result;
6. run `after_tool` to normalize model-visible content; and
7. append exactly one result entry under the provisioned ID.

Desktop MUST independently validate the tool name, capability generation,
relative path, containment, permission policy, Shell state, approval, argument
limits, and effect identity. A server request is never itself local authority.

### 14.1 Paths and Workspace privacy

All model and wire-protocol paths are relative to the granted Workspace. The
absolute local root MUST NOT be sent to Runtime, Kimi, Registry, Dashboard, or
telemetry. Runtime receives an opaque `workspace_grant_id` and a user-visible
folder label only.

The Workspace grant, security-scoped bookmark where applicable, permission
policy, and local effect receipts are stored by the Tauri/native layer in app
data. A raw Workspace root is not a WebView `localStorage` grant.

### 14.2 Bounded output

Model-visible local tool output is bounded at the source. Text output MUST be
limited to both 2,000 lines and 50 KiB per result, matching the proven Pi Coding
Agent policy. A result includes:

```text
truncated
included_bytes
original_bytes, when known
included_lines
original_lines, when known
next_cursor or result_ref, when more data exists
```

`fs.read`, search, and list operations use offsets/cursors. Long shell output
is retained in an ephemeral local spool and exposed only through an opaque,
installation-bound `result_ref`; no absolute spool path is sent to Cloud.

The current 4 MiB generic tool-result envelope is removed. Compaction is a
second line of defense, not the primary way to control unbounded tool output.

### 14.3 Replay and idempotency

Default replay policy is:

| Tool | Replay |
|---|---|
| `fs.list`, `fs.search`, `fs.read`, `git.diff`, `tool_output.read` | `safe` |
| `shell.exec` | `never` |
| `fs.write`, `fs.patch` | `never` unless a durable local receipt can answer without re-executing the mutation |

Desktop keeps a durable receipt keyed by `installation_id + effect_id` and
bound to the exact tool name, normalized arguments digest, Workspace grant,
and capability generation. A repeated request with the same binding returns
the prior result. A mismatched reuse is rejected as corruption.

A write that may have happened but has no durable receipt is closed with an
`interrupted` synthetic result; it is never blindly replayed. Delivery can then
inspect the target digest and ask the user before retrying. This is how Hatch
prevents duplicate or destructive recovery while remaining faithful to Pi's
tool crash model.

## 15. Workspace, permissions, and Shell

The Desktop chat header exposes three product controls:

1. Workspace selector;
2. permission selector; and
3. Shell access toggle.

Permission modes are:

```text
read_only
ask_before_changes
allow_changes
```

Read operations are allowed after the native Workspace grant. File changes
follow the selected mode. Shell is separately opt-in and always requires
per-call approval, including under `allow_changes`.

Every capability state carries a monotonically increasing
`capability_generation`. Workspace or permission changes do not reconnect the
WebSocket and do not start a local Runtime. Desktop sends a durable capability
update; Runtime applies it on the lane mutation line:

- a tool effect already started remains bound to its captured generation;
- a request waiting for approval under a revoked generation is denied or
  cancelled;
- lowering permissions prevents any not-yet-started effect immediately;
- the update becomes model-visible at the next Pi checkpoint; and
- all later tool calls carry the new generation.

Thus a mid-conversation change takes effect for the next model/tool action; it
does not retroactively change an effect already in progress. Switching folders
does not require a new Conversation, but prior folder evidence is isolated as
specified in section 11.

## 16. Delivery is a Pi-native workflow

Protected Creator delivery MUST NOT be implemented by copying a second message
history into hidden ad-hoc chat completions.

Hatch exposes a server tool, `hatch.delivery.submit`, that accepts a proposed
text or file Artifact. Its parent execution is durable under the same Pi
`tool_started`/result contract. The audit worker is a deterministic Pi child
Session, following Pi's subagent rule: its identity is derived from the parent
`session_id + tool_call_id`, so parent recovery reattaches to the same audit
worker instead of starting a second hidden completion. The parent tool may be
declared replay `safe` only because this reattachment and its audit receipts are
durable.

The workflow is:

1. model submits a candidate and requested Artifact metadata;
2. Runtime deterministically splits all Markdown into units and atomic claims;
3. the deterministic audit child Session runs Kimi review steps over bounded
   batches of at most five units, using only the product promise/boundaries and
   the relevant Creator/user/tool evidence;
4. Runtime—not the reviewer—computes complete coverage and the pass/fail
   verdict;
5. unsupported, conflicting, confidential, or out-of-scope content is revised
   and audited again within a bounded attempt limit;
6. a passing candidate receives a server-side delivery receipt and content
   digest;
7. for a file, Runtime schedules `fs.write` with that exact digest and content;
8. Desktop applies its normal approval policy and returns a local digest
   receipt; and
9. Runtime atomically/idempotently creates Artifact, Delivery, and Ledger
   references, then emits `delivery.ready` and completes the run.

Unsafe drafts, reviewer output, and revision traces remain server-private and
never stream to Desktop. A proposed file write that lacks a valid delivery
receipt is blocked before Desktop approval.

For a Release requiring audited delivery, `before_run_end` enforces the
presence of an accepted delivery receipt. It may queue a bounded follow-up that
asks the model to submit the candidate; it MUST NOT run an untracked hidden
review call. Every audit/revision provider attempt is a normal durable child
step with its own Pi usage record. The parent tool result also identifies the
child Session and accepted audit receipt; it does not duplicate the child's
transcript into the parent context.

Delivery identifiers are idempotent functions of account, entitlement, Task,
Artifact digest, and delivery attempt. A repeated client message, provider
retry, tool result, reconnect, or Runtime restart cannot create a second charge
or Delivery.

## 17. Wire protocol 1.0

Hatch wire protocol 1.0 is a clean replacement for 0.3. There is no
compatibility mode, `license_token`, dual parser, or client-selected Release
fallback. Runtime and Desktop deploy atomically with a minimum-client-version
gate.

### 17.1 Connection and snapshot

The initial client message contains:

```json
{
  "type": "client.hello",
  "protocol_version": "1.0",
  "installation_id": "...",
  "client_version": "...",
  "auth_token": "...",
  "entitlement_id": "...",
  "conversation_id": "...",
  "capabilities": {
    "generation": 7,
    "workspace_grant_id": "...",
    "workspace_label": "Documents",
    "permission": "ask_before_changes",
    "shell_access": true,
    "local_tools": ["fs.list", "fs.search", "fs.read", "fs.write", "fs.patch", "shell.exec", "git.diff", "tool_output.read"]
  }
}
```

After authentication and Release resolution, Runtime captures a Pi lane
snapshot and begins buffering live events in one operation. It sends the
client-safe `conversation.snapshot` completely before flushing buffered events.
This preserves Pi's snapshot-then-live, no-gap guarantee.

The snapshot includes visible conversation entries, current leaf, active run
and its state, provisional streaming text when the process is still alive,
running/pending tools, approval state, current capability generation, and
Delivery state. It excludes private Release material, model reasoning,
operation records, raw tool content not already approved for display, and
server credentials.

Reconnect is a fresh snapshot subscription. Events are live and non-durable;
the snapshot is the recovery source. No manual “Reconnect” action exists.

### 17.2 Required client-to-server messages

```text
client.hello
client.capabilities.update
client.message
tool_call.result
run.abort
```

`client.message` carries `client_message_id`, `conversation_id`, and the user
content. `run.abort` carries the server-issued `run_id`. A tool result carries
`run_id`, `turn_id`, `tool_call_id`, `effect_id`, captured capability
generation, and one of `ok`, `error`, `denied`, or `interrupted`.

### 17.3 Required server-to-client messages

```text
session.ready
conversation.snapshot
capabilities.accepted
run.accepted
assistant.delta
run.state
tool_call.request
tool_call.delta
approval.request
approval.result
workspace.diff
skill.activity
delivery.ready
run.completed
run.failed
run.aborted
```

Every run event carries `session_id`, `conversation_id`, `lane`, and `run_id`;
turn/tool events also carry `turn_id` and the relevant effect identity.
Events reporting durable facts are emitted only after commit.

`session.compacted` no longer sends a summary or replacement history to
Desktop. The UI may receive a content-free progress event; compaction details
remain server-side.

## 18. User-visible recovery and failure behavior

Failure is part of the product journey:

- Network loss: Desktop shows that the Task is being restored and reconnects
  automatically.
- Runtime process loss: a fresh harness restores the open operation and sends a
  new snapshot; partial stream text is replaced by durable state.
- Desktop loss during a tool: Runtime waits for rebind within policy, then
  reconciles by replay/receipt or an `interrupted` result.
- Permission denial: the denial becomes a tool result so the Agent can propose
  a non-destructive alternative.
- Provider retry: usage and attempt count remain durable; the user sees one
  Task, not duplicate assistant messages.
- Stop: `abort_requested` commits first, active effects receive an abort signal,
  unresolved calls get synthetic results, and the final product state is
  “Stopped”.
- Delivery failure: no unaudited draft or unacknowledged file is shown as
  complete. The Task presents a clear retry/recovery option without charging
  twice.

## 19. Observability and privacy

Pi events, hooks, telemetry, operation records, and product audit logs remain
separate channels:

- events are passive live UI observation;
- hooks may shape execution;
- records are durable recovery state;
- telemetry is passive process-local diagnostics; and
- the product audit log links business and execution identifiers.

Default telemetry includes IDs, names, counts, durations, status, stop reasons,
and usage. It MUST NOT include prompts, reasoning, completions, tool arguments,
tool output, file content, auth headers, provider payloads, or credentials.
Content capture requires explicit diagnostic authorization and redaction.

Desktop should clearly disclose that approved file excerpts and tool output
needed for the task are sent to the Cloud Runtime/model. “Local execution” MUST
NOT be presented as “file contents never leave this computer.”

## 20. Deployment boundary

Desktop has one environment: production Cloud. It connects only to the current
production Registry/Auth and Runtime endpoints. There is no user-facing or
silent fallback to a local backend.

The production Compose boundary remains:

```text
caddy
registry
runtime
dashboard
postgres
qdrant
```

Registry and Runtime are TypeScript services built with npm. Postgres is the
durable source for Registry/business state and Pi Session storage; Qdrant is
retrieval only. Caddy exposes the versioned Auth/Registry/Dashboard/Runtime
routes. GitHub Actions provides deployment credentials and application secrets
to the deployment/runtime environment; secrets are never baked into Desktop or
images.

## 21. Current implementation gaps

| Current implementation | Conflict | Required replacement |
|---|---|---|
| Direct `ChatCompletionsAgentRuntime` loop | No Pi operations, steps, reduction, or crash-safe resume | Pi Core `AgentHarness` on server |
| `RuntimeStore` JSONL plus `RunStateMachine` | Duplicate state model; not production multi-instance storage | Postgres Pi `SessionStorage` and record reduction |
| In-memory `ClientToolBroker.pending` | Pending local effects disappear on process loss | Pi `tool_started`, provisioned IDs, Desktop receipts, restore |
| `messages`, `auditMessages`, `productToolEvidence` and compact handoff | Duplicates tool history and breaks bounded context | One Pi tree plus ContextProjector |
| Hand-rolled `replacement_history` compaction | Rewrites provider history, lacks Pi retained-tail/recovery semantics | Pi `CompactionEntry` and checkpoint flow |
| Pinned Creator Release skips mid-turn compaction | Long real tasks cannot remain bounded | Same Pi compaction for every Agent |
| `thinking: disabled` | Violates the decided model contract | Thinking enabled for all Kimi roles |
| Direct OpenAI SDK dispatch in agent loop | Bypasses Pi model/usage/retry contracts | `@earendil-works/pi-ai` Models adapter |
| 4 MiB tool result | Context pressure is handled too late | 50 KiB/2,000-line source cap plus cursors |
| Raw `workspace_root` in hello and WebView storage | Leaks local authority into Cloud/WebView state | Native opaque Workspace grant |
| Socket restart on permission change | Configuration is transport-coupled | Generation-based capability update at checkpoint |
| Client-issued `run_id` | Weak idempotent acceptance and ownership | Server-issued Pi operation ID |
| Protocol 0.3 compatibility fields | Product explicitly requires no legacy mode | Atomic protocol 1.0 cutover |
| Delivery audit as hidden ad-hoc model calls | Untracked effects and duplicated context | Durable `hatch.delivery.submit` server tool |
| Audit batches of twenty units | Conflicts with Hatch v1 five-unit limit | Maximum five units per review batch |

These are migration findings, not optional cleanup. The old and new agent loops
MUST NOT coexist behind a per-Agent fallback in production.

## 22. Migration order

1. Pin the accepted Pi source/release and add exact npm dependencies.
2. Make the Pi Core adoption gate executable: no `HarnessNotImplemented` on any
   required path; Pi Tier A/B/C and package checks pass.
3. Implement Postgres `SessionStorage`, shared sequence, branch queries, usage
   projection, and fenced Session leases.
4. Implement the Kimi Pi AI adapter using `LLM_API_KEY`, official endpoint,
   `kimi-k2.6`, and thinking enabled.
5. Implement Hatch Release/system/Skill/RAG ContextProjector without duplicate
   transcript handoffs.
6. Implement remote-local `AgentTool` adapters, protocol 1.0 generated TS/Rust
   types, bounded results, cursors, and native durable effect receipts.
7. Implement capability generations and native Workspace grant storage.
8. Implement Pi-native delivery submission, five-unit audit batches, revision,
   local Artifact acknowledgement, and idempotent Delivery/Ledger linkage.
9. Change Desktop to snapshot-then-events, server-issued runs, automatic
   restore, and no reconnect action.
10. Run shadow conformance and production E2E, then atomically deploy the new
    Runtime and minimum Desktop version.
11. Delete protocol 0.3, legacy auth fields, the old run-state machine, the
    ad-hoc context handoff, and direct Chat Completions loop. No compatibility
    shim remains.

## 23. Acceptance gates

### 23.1 Pi conformance

- Tier A covers every restore prefix: provider retry, X1-X5 tool sites, abort,
  queues, deferred writes, compaction, overflow, and half-completed recovery.
- Tier B proves the exact record/entry order and that no effect begins before
  its intent.
- Tier C gates every effect, reopens after every durable prefix, and tests both
  legal orders of every Pi race.
- Automatic and manual drive produce the same durable log and outcome.
- Postgres passes the same SessionStorage/reduction suites as the Pi reference
  backend.

### 23.2 Hatch product conformance

- Website order creates one entitlement and the Agent appears in `My Agents`.
- The same account logs into installed Desktop and sees only entitled/owned
  Agents.
- User chooses Workspace, permission mode, and Shell access; no default folder
  is silently granted.
- A mid-conversation Workspace or permission change applies at the next
  checkpoint without reconnecting or mixing evidence.
- Thinking remains enabled in effective request records for assistant,
  compaction, reviewer, and revision calls.
- A long tool-heavy task crosses compaction and still produces the requested
  local file.
- Tool call/result pairs remain valid and model context stays bounded.
- A 50 KiB+ read or shell result uses truncation and continuation rather than a
  huge model message.
- Read tools recover safely; uncertain shell/write effects are never blindly
  replayed; receipt-backed duplicates do not execute twice.
- Stop works during model streaming, approval wait, local tool execution,
  compaction, and delivery audit.
- Runtime/Socket/Desktop restarts preserve the Task and do not duplicate the
  final answer, Delivery, order, or charge.
- An unsafe draft is revised; no unsafe text or write request reaches Desktop.
- The final Artifact digest, Task, Delivery, Order, entitlement, Release digest,
  and Ledger entries are linked.
- Desktop contains no private Release fields, raw Qdrant IDs, absolute path in
  cloud events, LLM key, or creator-only data.
- Installed Desktop uses only production Cloud endpoints.

## 24. Explicit non-goals

- running Pi, Kimi, RAG, or conversation state locally;
- embedding Pi Coding Agent as the Hatch product shell;
- supporting multiple model providers in Hatch v1;
- preserving protocol 0.3 or `license_token` compatibility;
- exposing lanes, compaction, operation records, or provider terminology as
  primary Desktop UI;
- sending protected Agent Corpus or Creator assets to Desktop; and
- treating a model completion without an audited, acknowledged result as a
  successful Delivery.
