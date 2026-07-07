# Hatch Technical Architecture

Status: architecture draft v0.1  
Scope: User Local Runner, Creator Skill Server, Hatch Registry

This document defines the first serious implementation shape for Hatch, a hybrid AI application runtime and distribution system. It is intentionally not a prompt marketplace and not a fully cloud-hosted SaaS runtime.

The core idea:

> Users own local context. Creators own protected skill logic. The platform owns distribution, identity, licensing, and update mechanics.

## 1. Design Goal

The product is a runtime and distribution layer for AI-native apps whose value depends on local user context.

The protocol must solve four problems at once:

1. **User input friction**  
   Users are more willing to provide real context when the app runs beside their local files rather than asking them to upload sensitive material into a public web form.

2. **Creator control**  
   Creators need control over model choice, token cost, workflow logic, quality, versions, and product behavior. A recipe-style Markdown skill is too thin.

3. **Creator protection**  
   The creator's method, prompt chain, routing logic, and workflow should not be distributed as plain text to users.

4. **Commercial distribution**  
   A skill-app should be installable, licensed, versioned, billed, updated, and revoked like software, not copied around like content.

## 2. Non-Negotiable Boundaries

The system has three independent planes.

```text
State Plane:
  User local filesystem and app sandbox.

Execution Plane:
  Creator-controlled OpenAI Agents SDK runtime.

Commerce Plane:
  Hatch Registry for metadata, signing, licensing, subscription, and versioning.
```

The platform does **not** touch user content in v0.1. It only handles metadata.

The creator does **not** receive raw local files. It receives sanitized context and can request local tools through a broker.

The local runner does **not** contain creator private workflow. It only mediates local files, privacy, tools, and audit.

The creator server does **not** own durable conversation memory in v0.1. User chat history, rehydrated transcript, privacy traces, and runtime event capture are local app state.

Source-of-truth rule:

```text
Vercel AI SDK UI = ephemeral user interface state
OpenAI Agents SDK = ephemeral creator-side run execution
Hatch Local Runner = durable local session state
```

## 3. High-Level Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                       User Device                               │
│                                                                 │
│  Desktop Local Runner                                           │
│  ├── App sandbox filesystem                                     │
│  ├── Local tools                                                │
│  ├── Privacy engine / privacyd                                  │
│  ├── Stable entity map                                          │
│  ├── Audit log                                                  │
│  └── Local UI                                                   │
│                                                                 │
└───────────────┬─────────────────────────────────────────────────┘
                │ WebSocket runtime channel
                │ sanitized context + local tool protocol
                ↓
┌─────────────────────────────────────────────────────────────────┐
│                  Creator Skill Server                           │
│                                                                 │
│  OpenAI Agents SDK Runtime                                      │
│  ├── Private instructions                                       │
│  ├── Workflow and model routing                                 │
│  ├── Creator-owned tools                                        │
│  ├── LocalToolBroker                                            │
│  ├── Token/cost control                                         │
│  └── Streaming agent output                                     │
│                                                                 │
└───────────────┬─────────────────────────────────────────────────┘
                │ metadata/license APIs only
                ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Hatch Registry                               │
│                                                                 │
│  ├── App listing                                                │
│  ├── Signed manifest                                            │
│  ├── Creator identity                                           │
│  ├── Subscription/license verification                          │
│  ├── Version updates                                            │
│  └── Billing split                                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 4. Why Desktop Local Runner

The first implementation should be a desktop local app, not a PWA.

Rationale:

- Local filesystem is the core product surface, not a convenience feature.
- Desktop can offer stable directory access, file watching, local indexing, local SQLite, keychain access, sidecar processes, and native notifications.
- Browser local filesystem APIs are promising but Chromium-centric, permission-sensitive, and awkward for long-lived app state.
- The value proposition already justifies installation: "install a local runner so external AI apps can work on your local context."

Recommended first stack:

```text
Tauri + React UI
Rust core for filesystem, sandbox, audit, WebSocket, keychain
Python privacyd sidecar for OpenAI Privacy Filter
SQLite + SQLCipher for private local runtime state
```

Electron is acceptable if speed of development matters more than binary size and native footprint. Tauri is preferred for a trust-oriented local runtime.

The native core is not optional architecture polish. It is where the product's trust boundary lives.

```text
Must live in native core:
  path containment
  app sandbox enforcement
  local tool execution
  file watching and indexing
  search
  patch/write/copy/move operations
  local audit log writes
  keychain and encryption operations
  runtime WebSocket backpressure/reconnect state

May live in React:
  chat surface
  workspace projection
  audit viewer
  install/settings UI
```

This avoids a common failure mode: a polished web UI with JavaScript holding the dangerous local filesystem boundary.

## 5. Local Runner

The Local Runner is the user's installed runtime. It owns the local app sandbox and mediates all access between creator logic and local state.

Responsibilities:

```text
install app manifest
create app sandbox
maintain local app files
run local privacy pipeline
store stable entity map
execute local tools
stream sanitized tool results to creator
write audit log
render local workspace UI
```

It is not responsible for:

```text
creator private instructions
model selection
token cost
workflow routing
creator eval pipeline
platform billing logic
```

### 5.1 Local App Sandbox

Each installed app gets a standalone directory under the platform root.

```text
PlatformRoot/
  apps/
    app_a/
      app.json
      workspace/
        inbox/
        state/
        outputs/
        sessions/
        media/
        tmp/
        audit.jsonl
```

The app has full permission inside its own sandbox. It cannot access other app directories.

This is intentionally similar to iOS app sandboxing:

```text
full permission inside the app container
no permission outside the app container
no cross-app access by default
```

### 5.2 Local Private Runtime State

Runtime-private state should not be placed in creator-readable workspace files.

Use encrypted local SQLite:

```text
LocalRunnerData/
  runtime.sqlite
  app_a/
    privacy.sqlite
```

Suggested storage:

```text
SQLite + SQLCipher
encryption key stored in OS keychain
macOS Keychain / Windows DPAPI / Linux Secret Service
```

Private state includes:

```text
installed app records
directory handles
license cache
local session / turn / remote run mapping
entity mapping
privacy scan cache
file content hashes
tool execution metadata
```

## 6. Privacy and PII Architecture

The privacy layer is not a simple redaction function. It is a stateful local privacy runtime.

It needs four capabilities:

```text
detect sensitive spans
map real entities to stable pseudonyms
sanitize outbound context
rehydrate creator output locally when needed
```

### 6.1 privacyd

Run privacy logic in a local sidecar service called `privacyd`.

```text
Local Runner UI/Core
  -> local IPC
privacyd
  -> deterministic scanners
  -> OpenAI Privacy Filter
  -> entity resolver
  -> sanitizer
```

The sidecar can be implemented in Python because OpenAI Privacy Filter is distributed as a Python package/CLI. Local Runner can call it through:

```text
Unix domain socket
localhost-only HTTP
stdio RPC
```

For v0.1, localhost-only HTTP is easiest to debug. Unix domain socket is better long-term.

### 6.2 Detector Stack

Use three layers.

```text
Layer 1: deterministic scanner
Layer 2: OpenAI Privacy Filter
Layer 3: stable entity map
```

#### Layer 1: deterministic scanner

This handles obvious sensitive patterns:

```text
email addresses
phone numbers
URLs
API keys
tokens
high-entropy secrets
account-like numbers
credential-looking strings
```

Likely libraries/patterns:

```text
regex recognizers
libphonenumber / phonenumbers
URL parser
entropy detector
gitleaks-like secret signatures
```

This layer is fast and should run before model detection.

#### Layer 2: OpenAI Privacy Filter

Use OpenAI Privacy Filter as the core local PII span detector.

Why:

- local open-weight model,
- Apache 2.0,
- designed for PII token classification,
- supports local CLI and Python use,
- more context-aware than regex-only detection.

Detected categories include identity and secret-like spans such as people, addresses, emails, phones, URLs, dates, account numbers, and secrets.

Important limitation:

OpenAI Privacy Filter is a privacy-by-design component, not a complete anonymization or compliance guarantee. It should be one layer in a broader local policy system.

#### Layer 3: stable entity map

OpenAI Privacy Filter detects spans. It does not solve continuity.

The Local Runner must keep a stable pseudonym map:

```text
PERSON_A -> local entity reference
ORG_A -> local entity reference
PROJECT_A -> local entity reference
FILE_A -> local file reference
```

The creator sees pseudonyms. The local runner keeps the mapping.

### 6.3 Entity Map

The entity map is a first-class local state object.

It makes three things possible:

1. The creator can reason over multiple turns using stable pseudonyms.
2. Local tools can resolve `PERSON_A` back to local files and records.
3. Creator output can be locally rehydrated or written into the correct sandbox file.

Suggested schema:

```sql
entities(
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  pii_type TEXT NOT NULL,
  pseudonym TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  encrypted_value BLOB NOT NULL,
  encrypted_aliases BLOB,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

entity_mentions(
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  file_ref TEXT,
  snippet_hash TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
```

`canonical_hash` should be:

```text
HMAC(per_app_salt, normalized_real_value)
```

This means:

- same app gets stable pseudonyms,
- different apps cannot correlate entities,
- creator cannot reverse the hash,
- platform does not receive mappings.

### 6.4 Sanitization Rules

Outbound context should preserve reasoning value while removing identity.

Examples:

```text
real person name       -> PERSON_A
real organization      -> ORG_A
real project           -> PROJECT_A
email                  -> EMAIL_A
phone                  -> PHONE_A
address                -> ADDRESS_A
secret/API key         -> <SECRET_REDACTED>
file path              -> FILE_A or logical sandbox path
```

Secrets are not rehydrated. They are permanently blocked from creator-facing context.

### 6.5 Performance Model

Do not scan the entire workspace every turn.

Use:

```text
file_hash + detector_version + policy_version cache
background indexing for changed files
selected-snippet scan in the hot path
lazy model load
warm privacyd process
CPU fallback
Apple Silicon / CUDA acceleration when available
```

Hot path:

```text
user turn
-> select candidate snippets
-> use cached spans when possible
-> scan only new or changed snippets
-> sanitize
-> send to creator
```

Cold/background path:

```text
new file enters sandbox
-> deterministic scan
-> OpenAI Privacy Filter scan
-> cache sensitive spans
-> update search index
```

## 7. Local Tools

The creator does not get shell access.

It gets a safe Unix-like subset mediated by the Local Runner.

Current v0.1 local tools:

```text
local.list
local.stat
local.search
local.read
local.write_file
local.append_file
local.apply_patch
local.copy
local.move
```

Unix analogy:

| Local Tool | Unix Analogy | Purpose |
| --- | --- | --- |
| `local.list` | `ls`, `find` | Discover sandbox structure |
| `local.stat` | `stat`, `wc` | Inspect metadata, size, mtime, hash |
| `local.search` | `rg`, `grep` | Find relevant context |
| `local.read` | `cat`, `sed`, `head` | Read sanitized file/snippet content |
| `local.write_file` | `tee > file` | Create or overwrite a file |
| `local.append_file` | `tee -a file` | Append to logs, memory, state |
| `local.apply_patch` | `patch`, `ed` | Precise edit |
| `local.copy` | `cp` | Duplicate files inside sandbox |
| `local.move` | `mv` | Move or rename files inside sandbox |

### 7.1 Local Tool Rules

Every local tool must:

```text
resolve paths under the app sandbox
reject cross-app access
reject private runtime state paths
sanitize read outputs before sending to creator
write audit events
return structured errors
```

The creator cannot call:

```text
shell
exec
raw_read
resolve_entity
network
delete
read outside sandbox
read privacy.sqlite
read runtime.sqlite
read audit secrets
```

No `delete` in v0.1. Use `local.move` into an app-level `.trash/` directory later if needed.

### 7.2 Local Tool Schemas

#### `local.list`

```json
{
  "path": "workspace/",
  "depth": 2
}
```

Returns:

```json
{
  "items": [
    {
      "ref": "FILE_A",
      "path": "workspace/state/lorem.md",
      "kind": "file",
      "content_type": "text/markdown"
    }
  ]
}
```

#### `local.stat`

```json
{
  "path": "workspace/state/lorem.md"
}
```

Returns:

```json
{
  "path": "workspace/state/lorem.md",
  "kind": "file",
  "size_bytes": 1234,
  "modified_at": "2026-01-01T00:00:00Z",
  "content_hash": "sha256:..."
}
```

#### `local.search`

```json
{
  "query": "PERSON_A lorem ipsum",
  "scope": "workspace/",
  "limit": 5
}
```

Returns sanitized snippets:

```json
{
  "matches": [
    {
      "ref": "SNIPPET_A",
      "file_ref": "FILE_A",
      "text": "PERSON_A previously said lorem ipsum...",
      "score": 0.82
    }
  ]
}
```

#### `local.read`

```json
{
  "ref": "FILE_A",
  "max_chars": 4000
}
```

Returns:

```json
{
  "ref": "FILE_A",
  "content": "PERSON_A lorem ipsum...",
  "truncated": false
}
```

Raw mode is not supported in creator-facing tools.

#### `local.write_file`

```json
{
  "path": "workspace/outputs/lorem.md",
  "content": "lorem ipsum",
  "overwrite": false
}
```

#### `local.append_file`

```json
{
  "path": "workspace/state/lorem.md",
  "content": "\n[note] PERSON_A lorem ipsum"
}
```

#### `local.apply_patch`

```json
{
  "path": "workspace/state/lorem.md",
  "patch": "*** Begin Patch\n...\n*** End Patch"
}
```

Patch format can be custom in v0.1, but it should be structured and auditable.

#### `local.copy`

```json
{
  "src": "workspace/outputs/lorem.md",
  "dst": "workspace/archive/lorem.md",
  "overwrite": false
}
```

#### `local.move`

```json
{
  "src": "workspace/outputs/lorem.md",
  "dst": "workspace/final/lorem.md",
  "overwrite": false
}
```

## 8. Creator Skill Server

The Creator Skill Server is where the protected skill logic lives.

It owns:

```text
private instructions
agent workflow
model selection
model fallback
token budget
creator-owned tools
version experiments
quality heuristics
```

It should use OpenAI Agents SDK as the runtime primitive.

Do not reimplement:

```text
agent loop
tool calling
handoffs
guardrails
streaming
tracing
```

Wrap the SDK, do not redefine it.

### 8.1 Agent Definition

Conceptual shape:

```python
agent = Agent(
    name="app_a",
    instructions=private_creator_instructions,
    model=creator_selected_model,
    tools=[
        local_list,
        local_stat,
        local_search,
        local_read,
        local_write_file,
        local_append_file,
        local_apply_patch,
        local_copy,
        local_move,
        *creator_internal_tools,
    ],
)
```

The local tools above are not executed on the creator server. They are proxy functions.

### 8.2 LocalToolBroker

Each creator-side local tool implementation does this:

```text
receive Agents SDK tool call
serialize tool.request over WebSocket
wait for Local Runner tool.result
return sanitized output to Agents SDK
```

This lets the creator agent see local tools as normal tools while preserving the boundary:

```text
agent can request local actions
Local Runner executes local actions
creator never gets raw filesystem access
```

### 8.3 Remote Runs, Not Remote Conversations

The creator server should execute remote runs. It should not own durable conversation state.

The durable conversation lives in the Local Runner:

```text
local_session_id
  -> local_turn_id
      -> remote_run_id
```

The Local Runner stores:

```text
raw user messages
rehydrated assistant messages
Vercel UI message state
Agent SDK-compatible run events/items
privacy traces
PII map
local tool audit
generated files
```

The creator server receives during a run:

```text
sanitized current turn
sanitized selected local history
sanitized selected file context
sanitized local tool results
```

The creator server may persist operational metadata:

```text
remote_run_id
app_id
hashed_install_id
hashed_local_session_id
hashed_local_turn_id
app_version
runtime_version
status
latency_ms
token_usage
tool_names
sanitized_error_category
```

It should not persist raw transcripts or rehydrated transcripts. In v0.1 it should not persist sanitized transcripts by default.

If the Local Runner exits, the remote run should be cancelled or marked interrupted. Resume means the Local Runner loads its durable local session and starts a new remote run. It does not ask the creator server to continue a hidden conversation.

This is the central execution/memory split:

```text
Conversation lives locally.
Run executes remotely.
Events stream back and are persisted locally.
Creator keeps metadata only.
```

## 9. Runtime Channel

The runtime channel should be bidirectional WebSocket, not HTTP polling.

Reason:

An agent turn is a long-running stream:

```text
user turn
-> agent streaming
-> local tool request
-> local tool result
-> agent continues
-> maybe more tool calls
-> final response
```

This is a natural WebSocket flow.

HTTP remains for:

```text
manifest download
license verification
version updates
billing metadata
creator metadata
```

### 9.1 WebSocket Message Types

```text
runtime.hello
runtime.ready
turn.start
agent.delta
agent.event
tool.request
tool.result
turn.final
turn.error
turn.cancel
runtime.error
```

### 9.2 `runtime.hello`

Local Runner opens a runtime connection to the creator endpoint.

```json
{
  "type": "runtime.hello",
  "app_id": "app_a",
  "installation_id": "inst_x",
  "license_token": "lic_x",
  "runner_version": "0.1.0",
  "protocol_version": "0.1"
}
```

Creator replies:

```json
{
  "type": "runtime.ready",
  "app_id": "app_a",
  "accepted_protocol_version": "0.1"
}
```

### 9.3 `turn.start`

```json
{
  "type": "turn.start",
  "local_session_id_hash": "sess_hash_x",
  "local_turn_id_hash": "turn_hash_y",
  "remote_run_id": "run_z",
  "input": [
    {
      "role": "user",
      "content": "lorem ipsum about PERSON_A"
    },
    {
      "role": "user",
      "content": "<sanitized_context>PERSON_A lorem ipsum...</sanitized_context>"
    }
  ],
  "context_policy": {
    "history": "local_selected_sanitized",
    "files": "local_selected_sanitized"
  },
  "local_tools": [
    "local.list",
    "local.stat",
    "local.search",
    "local.read",
    "local.write_file",
    "local.append_file",
    "local.apply_patch",
    "local.copy",
    "local.move"
  ]
}
```

### 9.4 `tool.request`

```json
{
  "type": "tool.request",
  "remote_run_id": "run_z",
  "local_turn_id_hash": "turn_hash_y",
  "tool_call_id": "tool_1",
  "name": "local.search",
  "arguments": {
    "query": "PERSON_A lorem ipsum",
    "scope": "workspace/",
    "limit": 5
  }
}
```

### 9.5 `tool.result`

```json
{
  "type": "tool.result",
  "turn_id": "turn_x",
  "tool_call_id": "tool_1",
  "output": {
    "matches": [
      {
        "ref": "SNIPPET_A",
        "file_ref": "FILE_A",
        "text": "PERSON_A previously said lorem ipsum...",
        "score": 0.82
      }
    ]
  }
}
```

### 9.6 `turn.final`

```json
{
  "type": "turn.final",
  "turn_id": "turn_x",
  "output": [
    {
      "type": "message",
      "content": "lorem ipsum final answer"
    }
  ],
  "usage": {
    "input_tokens": 1000,
    "output_tokens": 300
  }
}
```

## 10. Hatch Registry

The Hatch Registry is the commercial and distribution layer.

It does not ingest user content in v0.1.

Responsibilities:

```text
creator identity
app listing
manifest hosting
manifest signing
install records
subscription records
license verification
version updates
billing split
revocation list
```

### 10.1 Core APIs

```text
GET  /v1/apps
GET  /v1/apps/{app_id}/manifest
POST /v1/installs
POST /v1/licenses/verify
GET  /v1/apps/{app_id}/versions/latest
```

### 10.2 Manifest

```json
{
  "id": "app_a",
  "name": "App A",
  "version": "0.1.0",
  "creator_id": "creator_a",
  "creator_endpoint": "wss://creator.example.com/runtime",
  "runtime": "openai_agents_sdk",
  "permissions": {
    "filesystem": "app_sandbox_readwrite"
  },
  "local_tools": [
    "local.list",
    "local.stat",
    "local.search",
    "local.read",
    "local.write_file",
    "local.append_file",
    "local.apply_patch",
    "local.copy",
    "local.move"
  ],
  "privacy": {
    "mode": "local_sanitized",
    "entity_scope": "per_app"
  },
  "pricing": {
    "type": "subscription",
    "price_id": "price_a"
  },
  "signature": "..."
}
```

The Local Runner verifies the signature before installing.

The Creator Server verifies the license token before accepting runtime connections.

## 11. Local UI

The Local Runner UI should be functional and trust-oriented.

Primary surfaces:

```text
Installed Apps
Chat / Task Surface
Workspace Panel
Tool Activity
Audit Log
Settings
```

### 11.1 Installed Apps

Shows:

```text
installed apps
creator identity
app version
license/subscription state
last update
sandbox location
```

### 11.2 Chat / Task Surface

This is the primary user interaction surface:

```text
user input
agent streaming response
tool activity
final result
```

It should feel like the app is operating inside the local workspace, not like a remote SaaS chat form.

### 11.3 Workspace Panel

Projects the app sandbox filesystem into a browsable UI:

```text
inbox
state
outputs
sessions
media
tmp
```

This borrows the strongest lesson from file-system-first agent products:

> The UI should project filesystem state instead of duplicating product state in a separate database.

### 11.4 Audit Log

Audit is mandatory even if write operations do not require per-action confirmation.

For each turn:

```text
sanitized context sent
local tools requested
files read
files written
files copied/moved
privacy rules applied
creator endpoint contacted
token usage returned by creator
```

Audit entries should be local-first and human-readable.

Example:

```json
{
  "ts": "2026-01-01T00:00:00Z",
  "turn_id": "turn_x",
  "event": "local.tool.executed",
  "tool": "local.search",
  "arguments": {
    "query": "PERSON_A lorem ipsum",
    "scope": "workspace/"
  },
  "output_policy": "sanitized"
}
```

## 12. Security Model

Security is based on several nested boundaries.

### 12.1 Filesystem Boundary

```text
creator cannot access filesystem directly
local tools cannot escape app sandbox
private runtime state is outside creator-readable workspace
cross-app paths are rejected
```

### 12.2 Identity Boundary

```text
creator sees PERSON_A / ORG_A
creator never sees entity_map
creator cannot call resolve_entity
different apps get different pseudonym namespaces
```

### 12.3 Runtime Boundary

```text
creator owns LLM runtime
local runner owns local tool execution
platform owns registry and license metadata
```

### 12.4 Platform Boundary

```text
platform does not receive user content
platform does not receive entity maps
platform does not receive local audit logs by default
platform does not proxy runtime content in v0.1
```

### 12.5 No Shell

No shell access in v0.1.

The creator gets filesystem tools, not execution tools.

This prevents:

```text
arbitrary command execution
environment variable theft
network exfiltration
path traversal through shell tricks
unbounded local system access
```

## 13. What We Take From Content-Agent Style Systems

The useful lesson is not the exact stack.

The useful lesson is the separation:

```text
filesystem = durable product state
agent runtime = execution engine
frontend = event stream + filesystem projection
database = identity/billing/metadata, not content
```

For this protocol:

```text
Local Runner filesystem = product state
Creator OpenAI Agents SDK = execution engine
Hatch Registry database = identity/license/metadata
Local Runner UI = event stream + app sandbox projection
```

This avoids turning the chat history into the product database.

## 14. MVP Implementation Plan

### Phase 0: Repository skeleton

```text
local-runner/
creator-server/
platform-registry/
protocol/
examples/
```

### Phase 1: Hatch Registry metadata

Build:

```text
manifest schema
manifest signing
app listing
install endpoint
license verification stub
```

No content ingestion.

### Phase 2: Desktop Local Runner shell

Build:

```text
desktop app shell
PlatformRoot selection
install app manifest
create sandbox
workspace panel
audit log
WebSocket client
```

### Phase 3: Local tools

Implement:

```text
list
stat
search
read
write_file
append_file
apply_patch
copy
move
```

All tools:

```text
sandbox-contained
audited
structured errors
sanitized output on read/search
```

### Phase 4: privacyd

Implement:

```text
deterministic scanner
OpenAI Privacy Filter integration
entity map
sanitizer
scan cache
selected-snippet hot path
```

### Phase 5: Creator Skill Server

Build:

```text
OpenAI Agents SDK wrapper
private agent instructions
LocalToolBroker
WebSocket runtime endpoint
streaming turn handling
license verification
```

### Phase 6: End-to-end sample app

Create `app_a` using synthetic lorem ipsum data:

```text
install app_a
create sandbox
user sends turn
local runner sanitizes context
creator agent requests local.search
local runner returns sanitized snippets
creator agent writes output via local.write_file
local runner updates workspace panel and audit log
```

## 15. Explicit Non-Goals for v0.1

Do not build these yet:

```text
PWA local filesystem implementation
platform-managed full-content runtime
automatic eval telemetry
cross-app identity graph
creator access to raw local content
shell execution
delete tool
remote sync of local workspace
enterprise admin console
mobile client
marketplace ranking system
```

These may become v0.2+ work, but they should not block the first working architecture.

## 16. Open Questions

1. Tauri vs Electron for first desktop runner.
2. Exact local IPC boundary between Local Runner and privacyd.
3. Whether privacyd model weights are bundled or downloaded on first use.
4. Whether SQLCipher is required in v0.1 or v0.2.
5. How strict `local.apply_patch` format should be.
6. Whether `local.move` to `.trash/` should be first-class before delete exists.

Resolved decision:

- Creator server stores operational run metadata by default, not durable conversation state. Sanitized transcripts are not persisted by default in v0.1.

## 17. References

- OpenAI Agents SDK: https://openai.github.io/openai-agents-python/
- OpenAI Privacy Filter announcement: https://openai.com/index/introducing-openai-privacy-filter/
- OpenAI Privacy Filter repository: https://github.com/openai/privacy-filter
