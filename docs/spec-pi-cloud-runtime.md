# Hatch Pi Cloud Runtime contract

Status: normative MVP architecture. This document uses only behavior implemented
and tested in Pi `0.83.0`; speculative durable-harness behavior is outside the
Hatch implementation contract.

## 1. Product outcome

The runtime exists to complete this user journey:

```text
Registry entitlement
  -> Desktop login and Agent selection
  -> Workspace and permission selection
  -> Server-side Agent run
  -> Desktop executes local tools
  -> User receives a useful answer or file
```

The runtime is hosted in production. Desktop is a client and local tool executor;
it is not a second Agent runtime.

## 2. Architecture decision

Hatch uses Pi Core as the Agent loop, not Pi Coding Agent as a product runtime.

Pinned dependencies:

- `@earendil-works/pi-agent-core@0.83.0`
- `@earendil-works/pi-ai@0.83.0`

Hatch uses these implemented primitives:

- `Agent`
- `Agent.prompt()` and `Agent.continue()`
- `Agent.subscribe()` lifecycle events
- `Agent.abort()`
- tools plus `beforeToolCall` and `afterToolCall`
- `transformContext` and `convertToLlm`
- implemented context estimation and compaction helpers
- Pi AI model and streaming adapters

Hatch does not use or reproduce these unfinished or unnecessary concepts:

- `AgentHarness`
- lane, operation, step, effect, or effect journal
- automatic recovery after a Runtime process crash
- automatic tool replay
- durable stream continuation
- manual-drive execution gates
- Session forks or Pi subagent orchestration
- `watch()` as a durable snapshot/event primitive

These exclusions are intentional. The MVP optimizes the normal user journey, not
rare process-failure recovery.

## 3. Ownership boundary

```text
Dashboard / Registry
  account, Creator, current Agent Corpus, order, entitlement
                  |
                  v
Cloud Runtime ----+---- Postgres
  Pi Agent              conversation history and run status
  Kimi provider
  Agent Corpus / RAG
                  |
             authenticated WebSocket
                  |
                  v
Desktop
  UI projection
  Workspace grant
  permission approval
  local file and shell tools
```

### Cloud Runtime owns

- authenticating the account and checking Agent entitlement;
- binding a conversation to the current Agent and Corpus digest;
- loading server-private Agent instructions and corpus;
- constructing and running an in-memory Pi `Agent`;
- calling Kimi with thinking enabled;
- storing completed conversation messages in Postgres;
- streaming client-safe progress to Desktop;
- requesting local tools from Desktop;
- producing and auditing a final delivery.

### Desktop owns

- login and production Runtime connection;
- Agent and Workspace selection, plus one change policy: `Ask before changes`
  or `Allow changes`;
- native folder authorization;
- local file and shell execution;
- approval UI for file changes and Shell commands under `Ask before changes`;
- rendering the server's conversation projection;
- stopping the current live run.

Desktop does not own model context, Agent instructions, RAG retrieval, or canonical
conversation history.

### Registry owns

- account identity integration;
- Creator and Agent ownership;
- current Corpus digest, product offer, and publish state;
- order and entitlement;
- service-to-service authorization.

## 4. Runtime state model

Pi `Agent` is in-memory state for one active conversation run. Postgres is the
canonical history across connections and devices.

The initial schema needs only these concepts:

### `conversations`

- `id`
- `account_id`
- `entitlement_id`
- `agent_id`
- `corpus_digest`
- `title`
- `created_at`, `updated_at`

A conversation records the Corpus digest used for its runs. Publishing a new
Corpus creates a new current binding and does not rewrite prior audit records.

### `conversation_messages`

- `id`
- `conversation_id`
- `sequence`
- `run_id`
- `role`
- `source`
- `model_message` as `jsonb`
- `ui_text`
- `created_at`

`model_message` stores the completed model-visible message. `source` distinguishes
an account-authored user message from Runtime-injected control or tool messages.
Only account-authored messages may be projected as a user chat bubble.

### `runs`

- `id`
- `conversation_id`
- `client_message_id`
- `status`: `running`, `completed`, `failed`, or `stopped`
- `error_code`, `error_message`
- `started_at`, `finished_at`

Only one run may be active in a conversation. `client_message_id` prevents an
ordinary duplicate Send action from creating two runs; it is not a general durable
recovery mechanism.

### `tool_calls`

- `id`
- `run_id`
- `tool_call_id`
- `name`
- `status`
- `approval_state`
- client-safe argument and result summaries
- timestamps

This table supports UI status and diagnosis. It is not an effect journal and is
not used to replay tools.

### `context_checkpoints`

- `conversation_id`
- `through_sequence`
- `summary`
- retained recent messages
- token estimates and model metadata

The complete chat remains in `conversation_messages`. A checkpoint only controls
which context is sent to the model.

## 5. Normal execution path

For `client.message`:

1. Runtime authenticates the account and confirms entitlement to the bound Agent.
2. Runtime inserts the account message and a `running` run.
3. Runtime loads the latest checkpoint plus completed messages after it.
4. Runtime resolves the current Agent Corpus, system prompt, skills, knowledge, and tool list.
5. Runtime constructs Pi `Agent` with Kimi, thinking enabled, and remote tool adapters.
6. Runtime subscribes to Pi lifecycle events.
7. Runtime calls `Agent.prompt()` with the new account message.
8. Text deltas and tool status are streamed to Desktop.
9. Completed assistant and tool-result messages are stored in Postgres.
10. On `agent_end`, Runtime marks the run completed or failed and emits the final UI item.

Pi's mutable `Agent.state` is never treated as durable storage. A later turn rebuilds
the initial Agent state from Postgres and calls the implemented Pi API.

## 6. Failure scope for this version

The MVP handles ordinary provider, validation, tool, and network errors by returning
a clear failed state to the user.

Runtime process crashes, mid-effect recovery, partial-stream reconstruction, and
automatic tool replay are outside this version's design and acceptance scope. No
lane reducer, effect log, intent-before-effect record, or durable recovery state
machine will be built.

Workspace containment, approval before changes, entitlement checks, and secret
redaction remain mandatory because they are normal product security boundaries,
not rare-failure machinery.

## 7. Kimi and thinking

- Provider: the official Kimi endpoint through Pi AI.
- Model: the configured Kimi model, initially `kimi-k2.6`.
- Credential name: `LLM_API_KEY`.
- Thinking: enabled.
- Provider fallback: none in the first version.

Thinking is enabled through Pi's normal thinking-level option. Hatch does not add a
delivery-stage or per-turn output budget. When no explicit caller cap is supplied,
Pi AI uses the model profile's `maxTokens` and clamps it to the available context;
Pi owns the thinking-token policy for the selected level.

Reasoning content is server-private and is never projected into Desktop history.

## 8. Context and compaction

Model context is a projection of history, not the history itself.

Before a run, Runtime builds context from:

1. current Agent Corpus instructions;
2. relevant Agent Corpus / RAG evidence;
3. the latest compacted summary, if present;
4. recent completed conversation messages;
5. the new user message.

Hatch may call Pi's implemented estimation and compaction helpers at the normal
context checkpoint. It does not call unfinished `AgentHarness.compact()` behavior.

Rules:

- never delete full chat history because context was compacted;
- bound file and shell output at the tool boundary before it enters Pi's transcript;
- keep the standard assistant tool-call → tool-result pair in the next request;
- preserve the user's request, active constraints, accepted decisions, file changes,
  and unresolved work in the summary;
- let Pi compact the context only when its normal context policy requires it.

## 9. Local tool execution

All Workspace file and shell tools execute on Desktop. Runtime sends a typed request;
Desktop returns a typed result.

Every supported Desktop advertises the same complete local capability set in every
`client.hello`: `file_list`, `file_search`, `file_read`, `file_write`,
`file_patch`, `shell_exec`, and `git_diff`. Agent Corpus metadata and the selected
change policy must not remove tools from that list. These exact underscore names
are used at the model, Runtime, protocol, event, persistence, and Desktop
boundaries; there is no parallel `fs.*` family or provider-only rename. The
server-owned Creator knowledge tool remains explicitly namespaced as
`hatch.file_search` (model function `hatch_file_search`) and is not the local
Workspace `file_search` tool.

Required request fields:

- `run_id`
- `tool_call_id`
- tool name
- validated arguments
- Runtime approval advisory (currently always `auto`; it is not an authorization)

Required Desktop checks:

- a native folder picker created the opaque Workspace grant, and Desktop restored
  and probed that grant successfully before showing the composer or connecting
  local tools;
- the target resolves inside the currently granted Workspace;
- `file_list`, `file_search`, `file_read`, and `git_diff` execute automatically;
- file changes and every Shell command request approval when the selected
  changes policy requires it;
- Shell is always available as a Desktop capability and has no separate user
  setting;
- command and output are shown in a user-comprehensible form;
- output returned to Runtime is bounded.

The granted Workspace is a user-data security boundary, not merely the Shell's
working directory. On the supported macOS Desktop, `shell_exec` must run behind
an OS-enforced, fail-closed sandbox: the command may read and write the granted
Workspace, may read the minimum system runtime and executable paths needed to
run, and may use a per-call private scratch directory. It may not read or write
other user data or open network connections. Relative paths, absolute paths,
redirection, symlinks, nested shells, and child processes are all subject to the
same kernel policy. Approval changes whether a requested mutation needs a user
gesture; it never weakens containment.

This is a path-access boundary rather than a promise to duplicate filesystem
inodes. If a user deliberately places a pre-existing hard link in the Workspace,
writing that Workspace path retains the operating system's normal shared-inode
semantics. Hatch does not follow or open an outside path to perform that write.

The production Desktop must self-check the secure Shell backend before declaring
its normal capabilities. If that backend is unavailable, Hatch blocks the local
tool connection with an actionable error and never falls back to a raw host
shell.

The Workspace grant identifier, selected root, and project instruction files are
not `client.hello` or tool-request fields and are never uploaded merely because a
Workspace was selected. User-authorized tool output can naturally contain a path
(for example, `pwd` or a compiler diagnostic), and that result is sent to the
Runtime as model context. Literal path replacement may reduce accidental display,
but is not a privacy or containment boundary and must not be described as one.

Changing Workspace or permission settings during a chat applies to the next user
turn. It does not mutate a tool call already in progress.

The first version never replays a local tool automatically. A failed tool request is
shown as failed and the Agent may explain or request a fresh call.

## 10. Chat history and UI projection

Runtime exposes one client-safe conversation projection. Desktop does not rebuild
history independently from raw model messages.

One run projects to one assistant work item containing ordered parts such as:

- visible assistant text;
- local tool request and status;
- approval request;
- delivery/file result;
- visible error.

Never project:

- system prompts or protected Skill content;
- hidden RAG corpus text or internal identifiers;
- raw reasoning;
- credentials or service tokens;
- unrestricted tool arguments or raw tool output;
- Runtime-internal user-role messages as if the account authored them.

On opening a conversation, Desktop fetches a Postgres-backed snapshot and then
subscribes to live events for the current process. Pagination loads older projected
items. This is a Hatch protocol, not Pi `watch()`.

If a connection drops, Desktop reloads the latest completed snapshot. The MVP does
not reconstruct an interrupted partial stream.

## 11. Stop behavior

While streaming, Send becomes Stop. Runtime maps Stop to the active implemented
`Agent.abort()` call, waits for the Agent to settle, marks the run `stopped`, and
keeps any previously completed messages.

There is no separate Reconnect action in the chat UI. Connection recovery is an
automatic transport concern; the visible user action is Retry only after an actual
failed request.

## 12. Delivery

Delivery is a Hatch product workflow around the Pi Agent, not a Pi fork or subagent
primitive.

Before presenting a final file result, Runtime must verify that:

- the requested artifact exists;
- its format and location match the user's request;
- validation required by the Agent ran successfully;
- the final response links or names the result clearly.

If a second model pass is used to audit or revise a delivery, it is an explicit Hatch
service operation with bounded input. It must not smuggle the full tool transcript
into another completion.

## 13. Protocol surface

The production protocol 0.6 requires:

- authenticated connection handshake;
- account and entitlement binding;
- Agent Corpus and conversation binding;
- client capability declaration for local tools;
- conversation snapshot and pagination;
- `client.message` with `client_message_id`;
- run/text/tool/approval/delivery events;
- local tool result;
- stop request;
- final run status.

The protocol is versioned as the new contract. No compatibility layer for the old
local Runtime or old Registry endpoints is required.

## 14. Implementation order

1. Pin Pi Core and Pi AI with npm and the repository lockfile.
2. Add Postgres conversation, message, run, tool-call, and checkpoint storage.
3. Replace the custom Chat Completions loop with implemented Pi `Agent`.
4. Add the Kimi Pi AI adapter with thinking enabled and `LLM_API_KEY`.
5. Bridge typed Pi tool calls to Desktop local execution.
6. Add the single client-safe history and live-event projector.
7. Add context bounding and completed-turn compaction.
8. Add Stop through `Agent.abort()`.
9. Remove local Runtime and JSONL/chat-disk history paths.
10. Exercise the complete production user journey.

Do not implement `AgentHarness` or any of the excluded durable-recovery concepts as
part of these steps.

## 15. Acceptance criteria

- Desktop uses only the production Registry and Runtime endpoints.
- The same account sees only entitled or owned Agents.
- A conversation records the exact Agent Corpus digest used for each run.
- A user can select Workspace and whether Hatch asks before changes, then
  complete a task with Shell available.
- The native Workspace grant is selected and read-probed during onboarding; the
  composer and local-tool connection are unavailable until that gate succeeds.
- Every hello advertises the complete supported local tool set. Reads run
  automatically; only `file_write`, `file_patch`, and `shell_exec` consult the
  Desktop's Ask/Allow policy.
- Pi `Agent` performs the server-side loop with Kimi thinking enabled.
- File and Shell tools execute only on Desktop; Shell cannot open other user-data
  paths or the network, and writable paths are limited to the granted Workspace
  and private per-call scratch, subject to documented hard-link inode semantics.
- Changes request approval according to the selected permission policy.
- Completed chat history survives Desktop restart and is loaded from Postgres.
- Context compaction does not remove visible chat history.
- Tool output is bounded before another model request.
- Stop ends the active live run.
- Protected instructions, reasoning, secrets, and raw tool data do not leak to UI.
- A provider or tool error becomes a clear failed state the user can retry.
- No test or code path depends on unfinished Pi `AgentHarness` behavior.
