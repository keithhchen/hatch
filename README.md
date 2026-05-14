# Hatch

Hatch is a prototype runtime for distributing **Skill Apps**: creator-owned agent programs that execute against user-owned local state.

This README is the engineering map of the system: process topology, trust boundaries, agent runtime integration, local filesystem state, privacy transformation, and tool-call protocol.

## Process Topology

```text
┌────────────────────────────────────────────────────────────────────┐
│ User machine                                                       │
│                                                                    │
│  desktop-app/                 local-runner/          privacyd/     │
│  Desktop UI     ───────────>  Rust native core  ───> Privacy sidecar│
│       │                         │                      │           │
│       │                         │                      └─ privacy adapter │
│       │                         ├─ app sandbox                      │
│       │                         ├─ local tools                      │
│       │                         ├─ entity map                       │
│       │                         ├─ audit log                        │
│       │                         └─ runtime socket client            │
│       │                                                            │
└───────┼─────────────────────────┼──────────────────────────────────┘
        │                         │
        │ install metadata         │ runtime events / tool protocol
        ▼                         ▼
┌──────────────────────┐     ┌───────────────────────────────────────┐
│ platform-registry/   │     │ creator-server/                       │
│ Registry API         │     │ Agent Runtime Adapter                  │
│                      │     │                                       │
│ manifests            │     │ private Skill instructions            │
│ signatures           │     │ model/provider configuration          │
│ install records      │     │ run/event/tool-call lifecycle          │
│ license checks       │     │ brokered local tool calls             │
└──────────────────────┘     └───────────────────────────────────────┘
```

The system has three live instances:

1. **User client side**: desktop app + Rust local runner + privacy sidecar.
2. **Creator server side**: private Skill runtime built behind an agent runtime adapter.
3. **Platform server side**: registry and distribution metadata.

Runtime responsibility mapping:

```text
Platform Registry
  input/output: public manifests, signatures, install/license metadata

Creator Skill Server
  input/output: sanitized run context, agent stream events, tool-call requests

User Local Runner
  input/output: local files, entity maps, audit log, tool execution results
```

## Repository Layout

```text
platform-registry/
  Registry service for manifests, signatures, installs, and licenses.

creator-server/
  Creator runtime. Uses an agent runtime adapter and exposes a WebSocket
  runtime endpoint for runs, streaming, and local tool requests. The current
  adapter targets the OpenAI Agents SDK, but the layer is intentionally
  runtime-replaceable.

privacyd/
  Local privacy sidecar. Hosts the privacy adapter/context compiler used to
  detect, transform, and rehydrate sensitive local context. OpenAI Privacy
  Filter is one possible implementation choice, not the protocol itself.

local-runner/
  Rust native boundary for filesystem state, sandbox enforcement, local
  tools, path containment, and audit logs.

desktop-app/
  Desktop UI shell for installing Skill Apps, chatting, and viewing
  local workspace state.
```

## Runtime Planes

Hatch splits the system into three planes.

### 1. State Plane

Owned by the user device.

```text
.hatch-local/
  apps/
    <app_id>/
      files/
      state/
      sessions/
      audit.jsonl
      entity-map.json
```

This plane contains:

- app sandbox files,
- local chat transcript,
- privacy placeholder map,
- local audit log,
- tool effects,
- local app state.

### 2. Execution Plane

Owned by the creator runtime.

This plane contains:

- agent runtime definitions,
- private Skill instructions,
- model/provider configuration,
- creator-owned tools,
- workflow routing,
- token spend and model calls.

### 3. Distribution Plane

Owned by the platform registry.

This plane contains:

- public manifests,
- signed install metadata,
- app listing metadata,
- creator identity,
- license status,
- version metadata.

The registry does not store user content, chat transcripts, entity maps, or creator private prompts.

## Core Runtime Loop

The runtime loop is turn-based, but the transport is bidirectional because the agent may stream output and request local tools during a run.

```text
1. User sends a message in desktop UI.
2. Local Runner loads relevant local app/session state.
3. privacyd sanitizes user context and updates stable entity map.
4. Local Runner opens or reuses runtime WebSocket to Creator Skill Server.
5. Creator Skill Server starts an adapter-backed agent run.
6. Agent runtime adapter emits stream events and optional tool calls.
7. Local tool calls are brokered back to Local Runner.
8. Rust local-runner validates path/capability/sandbox.
9. Tool result is sanitized before returning to Creator Skill Server.
10. Adapter-backed run continues until final output.
11. Local Runner rehydrates safe output for the user.
12. Local transcript, audit log, and file effects are committed locally.
```

In pseudo-event form:

```text
client.message.created
privacy.context.sanitized
creator.run.started
creator.run.delta
creator.tool.requested
local.tool.approved
local.tool.completed
creator.run.completed
local.output.rehydrated
local.audit.committed
```

## Runtime Channel

The creator runtime and local runner communicate over WebSocket.

Representative event envelopes:

```json
{
  "type": "run.start",
  "run_id": "run_123",
  "app_id": "peopleos",
  "session_id": "sess_abc",
  "input": {
    "text": "sanitized user message",
    "context_refs": ["notes/recent.md"]
  }
}
```

```json
{
  "type": "tool.call",
  "run_id": "run_123",
  "tool_call_id": "call_456",
  "name": "fs.write_file",
  "arguments": {
    "path": "reminders/follow-up.md",
    "content": "sanitized content"
  }
}
```

```json
{
  "type": "tool.result",
  "run_id": "run_123",
  "tool_call_id": "call_456",
  "status": "ok",
  "result": {
    "path": "reminders/follow-up.md",
    "bytes_written": 128
  }
}
```

The protocol is intentionally close to mainstream agent runtime primitives:

- runs are turn-scoped,
- events stream,
- tool calls are explicit,
- tool results are sent back into the run,
- conversation state is rehydrated locally rather than centrally stored.

## Agent Runtime Adapter

`creator-server` implements one `AgentRuntimeAdapter`.

```ts
type RuntimeName = "openai-agents-sdk" | "claude-agent-sdk" | "pi-agent" | string;

interface AgentRuntimeAdapter {
  runtime: RuntimeName;

  createRun(input: CreateRunInput): Promise<RunHandle>;
  stream(run: RunHandle): AsyncIterable<RuntimeEvent>;
  submitToolResult(run: RunHandle, result: ToolResult): Promise<void>;
  cancelRun(run: RunHandle, reason?: string): Promise<void>;
}
```

### CreateRunInput

```ts
interface CreateRunInput {
  run_id: string;
  app_id: string;
  session_id: string;
  sanitized_messages: RuntimeMessage[];
  available_tools: ToolSpec[];
  metadata: {
    license_id?: string;
    manifest_version: string;
  };
}
```

### RuntimeEvent

```ts
type RuntimeEvent =
  | { type: "run.started"; run_id: string }
  | { type: "run.delta"; run_id: string; delta: string }
  | { type: "tool.call"; run_id: string; call: ToolCall }
  | { type: "run.completed"; run_id: string; output: RuntimeOutput }
  | { type: "run.failed"; run_id: string; error: RuntimeError }
  | { type: "run.cancelled"; run_id: string; reason?: string };
```

### ToolCall

```ts
interface ToolCall {
  tool_call_id: string;
  name: string;
  arguments: Record<string, unknown>;
}
```

### ToolResult

```ts
interface ToolResult {
  tool_call_id: string;
  status: "ok" | "error" | "denied";
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}
```

### Adapter Requirements

```text
MUST create turn-scoped runs.
MUST stream ordered RuntimeEvent objects.
MUST expose structured tool calls.
MUST accept ToolResult objects after local execution.
MUST preserve run_id and tool_call_id.
MUST surface failed and cancelled states.
MUST keep creator private instructions outside Hatch Local Runner.
MUST NOT require Hatch Platform Registry to observe run contents.
```

The current adapter implementation targets OpenAI Agents SDK primitives. That is an implementation of this interface, not the interface definition.

## Rust Native Boundary

Rust is not used here as speculative performance optimization. It is the local trust boundary.

The Rust `local-runner` owns operations where correctness matters more than UI convenience:

- path normalization and traversal prevention,
- app sandbox root enforcement,
- local tool execution,
- file reads/writes/moves/copies/deletes,
- audit log append semantics,
- runtime channel backpressure/reconnect state,
- future file watching and indexing,
- future keychain/encryption integration.

The UI process should not decide whether a tool call is safe. It should ask the Rust core.

```text
UI intent
  -> native command
  -> Rust validation
  -> sandboxed filesystem operation
  -> audit append
  -> UI state update
```

## Filesystem As State Machine

Each installed Skill App gets a standalone local filesystem sandbox.

The filesystem is not just storage. It is the durable state machine the agent acts on:

- files are user-editable state,
- directories encode app-specific schema,
- tool calls are state transitions,
- audit logs are transition history,
- chat turns are local session state,
- entity maps are privacy state.

Example declared schema:

```text
peopleos/
  contacts/
  notes/
  reminders/
  summaries/
```

The creator manifest can declare the expected structure. The Local Runner materializes it under the user-owned app sandbox.

## Privacy Adapter / Context Compiler

The local privacy layer is an adapter boundary, similar to the agent runtime boundary.

Hatch requires a **context compiler** contract, not a specific PII vendor/model. OpenAI Privacy Filter can be one implementation choice for detecting and redacting sensitive spans, but Hatch should also be able to swap in deterministic scanners, local NER models, custom rules, domain-specific classifiers, or future privacy models.

The compiler pipeline:

```text
raw local context
  -> detect sensitive spans
  -> replace with stable placeholders or lower-resolution abstractions
  -> send sanitized context to creator runtime
  -> receive output/tool requests
  -> rehydrate locally when safe
```

Example:

```text
Local:
  Had coffee with Maya. She is thinking about leaving her job.

Sanitized:
  Had coffee with PERSON_A. PERSON_A is thinking about a career change.

Local output:
  Add a reminder to check in with Maya about the job decision.
```

Important properties:

- placeholders are stable within the local app/session scope,
- raw-to-placeholder mapping never leaves the user device,
- sanitization must preserve enough semantic structure for the creator runtime to reason,
- local tool calls are rehydrated and validated locally before execution,
- the implementation can change without changing the Creator Skill Server or Platform Registry protocol.

## Local Tool Protocol

Local tools are capability APIs, not shell commands.

Representative tool surface:

```text
fs.list
fs.read_file
fs.write_file
fs.append_file
fs.patch_file
fs.mkdir
fs.cp
fs.mv
fs.rm
fs.search
fs.tree
audit.query
```

Every tool call is checked against:

- installed app ID,
- sandbox root,
- path normalization,
- declared capability,
- write/read permission,
- audit policy.

The creator server can ask for a local operation. Only the Local Runner can execute it.

## Platform Manifest

The public manifest is the platform-distributed object.

Representative fields:

```json
{
  "app_id": "peopleos",
  "name": "PeopleOS",
  "version": "0.1.0",
  "creator_id": "creator_123",
  "runtime_url": "wss://creator.example.com/runtime",
  "filesystem_schema": {
    "directories": ["contacts", "notes", "reminders", "summaries"]
  },
  "required_tools": ["fs.read_file", "fs.write_file", "fs.search"],
  "signature": "..."
}
```

The manifest should be enough for the user client to install and route the app. It should not contain the creator's private instructions or prompts.

## Data Ownership Matrix

```text
Artifact                         Owner / Location
------------------------------------------------------------
Public manifest                  Platform Registry
Signed manifest                  Platform Registry + Local Runner
Private Skill prompt             Creator Skill Server
Model/provider config            Creator Skill Server
User files                       User Local Runner
Chat transcript                  User Local Runner
Placeholder/entity map           User Local Runner
Tool audit log                   User Local Runner
License record                   Platform Registry
Runtime stream                   Creator Server <-> Local Runner
```

## Verification

Component checks:

```bash
cd platform-registry && uv run --extra dev pytest
cd creator-server && uv run --extra dev pytest
cd privacyd && uv run --extra test pytest
cd local-runner && PATH="$HOME/.cargo/bin:$PATH" cargo test
cd desktop-app && npm run build:web
cd desktop-app/src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test
```

## Technical Decisions

- Desktop first, because local filesystem state is core runtime state.
- Desktop shell for UI, Rust for the trusted local boundary.
- Agent runtime adapter for creator-side execution. Current adapter uses OpenAI Agents SDK, but the Hatch protocol should also be able to support Claude/Pi-style agent runtimes.
- WebSocket for run streaming and tool-call round trips.
- Platform Registry is metadata-only in v0.1.
- User chat/session state is local, not creator-hosted.
- Sanitization is local and stable, not per-turn random masking.
- Local tools are explicit capabilities, not shell access.
- Creator submits manifest; creator does not upload private Skill logic to platform.

## Further Reading

- [Technical Architecture](docs/technical-architecture.md)
- [Technical Stack](docs/technical-stack.md)
- [Creator Skill Modules](docs/skill-modules.md)
- [Product Spec v0.1](docs/product-spec-v0.1.md)
