# Hatch TypeScript Runtime Server

This is the clean TypeScript implementation of the Hatch runtime loop:

```text
server agent runtime
  owns LLM calls, skill catalog, web/API tools

Desktop local client / Rust runner
  owns filesystem, shell, git, workspace containment
```

The client never receives provider credentials and never imports an LLM SDK.
The local executor is the Desktop/Tauri client and its Rust `local-runner`
sidecar. It executes deterministic local tools while agent thinking, sessions,
skill loading, and all LLM calls stay on the single Shanghai cloud Runtime.
The canonical wire protocol schema lives in `../packages/protocol/schemas/hatch-wire-protocol.schema.json`; the server and Rust runner should mirror that schema until generated TS/Rust types are introduced.

## Agent Corpus

The current publish path can resolve a runtime-free Corpus directly from
`HATCH_AGENT_CORPUS_ROOT/<creator_id>/<agent_id>`. A `client.hello` that carries
`creator_id` and `agent_id` loads that current Corpus directly. The server
always loads `instructions/system.md`, activates
only the matching local Skill and its references, and never puts Evals into the
runtime context. The Corpus declares `hatch.web_search`; the retrieval tool is
exposed as `hatch.file_search` only when a knowledge provider is configured.

The retrieval provider is Qdrant plus DashScope. Run Qdrant from
`infra/docker-compose.rag.yml` and configure `HATCH_QDRANT_URL` (use
`http://127.0.0.1:6333` when Runtime runs as a host service; use
`http://qdrant:6333` when it shares the Compose network),
`HATCH_QDRANT_API_KEY`, `HATCH_QDRANT_COLLECTION`, and `DASHSCOPE_API_KEY`.
Registry indexes only `knowledge/*.md` at Corpus publication time. Runtime
exposes `hatch.file_search` only for an Agent with knowledge and calls Qdrant
on demand, then reranks candidates with `qwen3-rerank`; it never eagerly puts
retrieved knowledge in the system prompt. `HATCH_KNOWLEDGE_MODE=corpus-test`
remains reserved for explicit contract tests.

## Install

```bash
npm install
```

## Build And Test

```bash
npm run build
npm run test
```

Tests inject deterministic Pi provider doubles where needed. The server entrypoint itself always uses the Pi Core Agent runtime; Moonshot is reached through Pi AI's OpenAI-compatible transport.

## Skills And Tools

Skills use the Agent Skills file format:

```text
<skill-name>/SKILL.md
<skill-name>/scripts/
<skill-name>/references/
<skill-name>/assets/
<skill-name>/agents/openai.yaml
```

`SKILL.md` must have YAML frontmatter with `name` and `description`, followed by Markdown instructions. The `name` field follows the Agent Skills spec: 1-64 characters, lowercase letters/numbers with single hyphen separators, no leading/trailing/consecutive hyphens, and it must match the parent skill directory name. Optional `license`, `compatibility`, and `allowed-tools` fields must be strings, and `metadata` must be a string map; `allowed-tools` is the spec's space-separated string, not a YAML array. Malformed skills are skipped and never made model-visible; direct loads of malformed `SKILL.md` files fail. When a skill comes from a plugin, the model-visible skill name is qualified as `plugin-namespace:skill-name`, but the underlying `SKILL.md` `name` still follows the unqualified spec.

At session startup the server discovers skills from:

```text
runtime-server/skills
HATCH_SKILL_ROOTS
explicit roots passed by the creator/runtime package
```

It does not scan workspace `.codex/skills`, workspace ancestor `.codex/skills`, `$CODEX_HOME/skills`, `$CODEX_HOME/skills/.system`, `$CODEX_HOME/plugins/cache`, `/etc/codex/skills`, or `~/.codex` by default. Symlinked skill folders are followed inside configured server-side skill roots.

`HATCH_SKILL_ROOTS` is a path-delimited list of creator/server-owned skill roots.
Use it for packaged creator app skills; do not rely on user workspace folders
as implicit skill sources.

`agents/openai.yaml` is parsed for OpenAI Agent Skills metadata. `policy.allow_implicit_invocation: false` hides the skill from implicit model selection; explicit `$skill-name` mentions or linked `[$skill-name](/path/to/SKILL.md)` mentions still activate it for that turn. `policy.products` is enforced only when `HATCH_SKILL_PRODUCT` is set to `codex`, `chatgpt`, or `atlas`; by default product-restricted skills are not model-visible.

The runtime tracks protected skill execution on the event stream. The main agent receives public metadata and invokes `skill_run`; the server creates a headless `SkillRuntime` session that reads the private `SKILL.md`. The client sees `skill.run` status and brokered tool correlation, but never receives the worker prompt or raw transcript.

The model-visible skills list follows Agent Skills progressive-disclosure budgeting: it uses at most 2% of a known model context window, or 8,000 characters when the context window is unknown. Set `HATCH_MODEL_CONTEXT_WINDOW_CHARS` when a provider exposes a known window. `HATCH_SKILL_METADATA_BUDGET_CHARS` can override the computed value for deterministic tests or constrained deployments.

`HATCH_SKILLS_CONFIG=/path/to/config.toml` can configure skills. `include_instructions = false` suppresses the session skills catalog. `[skills.bundled].enabled = false` excludes bundled `runtime-server/skills`. `[[skills.config]]` entries configure individual skills by path or by skill name. Rules are applied in file order, so a later name selector can override an earlier path selector and vice versa:

```toml
[skills]
include_instructions = false

[skills.bundled]
enabled = false

[[skills.config]]
path = "/path/to/skill/SKILL.md"
enabled = false

[[skills.config]]
name = "github:yeet"
enabled = false
```

This package implements the Agent Skills protocol semantics over a Pi Core Agent using Kimi K2.6 through Pi AI:

```text
startup context: skill name + description + public SKILL.md locator
selection: main agent calls `skill_run` with the public skill id and task
private execution: SkillRuntime loads the complete private SKILL.md inside a headless worker session
resource loading: the worker loads private skill resources on demand
tool execution: Pi tool calls mapped to server tools or brokered local tools
tool events: requested/completed/failed status streams as `tool_call.delta`; local writes can also stream `workspace.diff`
```

It does not expose `load_skill(skill_id)` as a model-visible tool. `skill_run` is the product runtime boundary: it is a normal Pi tool to the main agent, while the private skill body stays inside the server worker. The main agent cannot use `file_read` to load protected `SKILL.md` content.

Hatch does not use the Responses API or OpenAI hosted/local `shellTool`. The Agent harness is Pi Core + Pi AI. Pi AI uses Moonshot's OpenAI-compatible Completions transport at the provider boundary; Hatch does not instantiate a second OpenAI SDK client or maintain a parallel model loop.

## Runtime Contract

The server builds base instructions for each model call from:

```text
system: runtime identity, security rules, and tool execution boundaries
user context: server-rendered per-session Agent Skills catalog
worker context: private skill instructions inside SkillRuntime only
conversation: server-hydrated prior user/assistant messages
conversation: current user message
```

`client.hello` initializes the session skill context once: the server discovers skills, renders the catalog, and stores that context on the WebSocket session. Later `client.message` turns reuse the same rendered catalog so the model-call prefix stays stable for prompt caching. New sessions discover again.

The public skill catalog is injected as server-authored `user` context prefixed with `HATCH RUNTIME CONTEXT`; private skill instructions are injected only into the worker context. Context compaction excludes rebuilt server context messages because the server reconstructs them from fixed session state. Consumer workspace paths and project instruction files are never sent to the Runtime or model.

Model-visible function tools are generated from the canonical runtime tool spec registry in `tools.ts`. Server tools are always owned by the runtime server. Client tools are exposed only when the `client.hello.local_tools` session capability says the Desktop client can execute them.
`file_read` and `file_list` are local workspace tools for the main agent. Protected skill resource paths are available only to SkillRuntime through the same ToolBridge and are never sent to the client as server-hosted skill content.
`shell_exec` accepts an optional `justification` field as model-visible reasoning context for the command. Local tools currently run with `auto` permission when the client declares the capability; the Rust `local-runner` still enforces workspace containment and deterministic execution policy.
SkillRuntime loads the private `SKILL.md` and its resource manifest server-side. Relative paths under `references/`, `scripts/`, and `assets/` resolve against the worker's private skill directory. The main conversation receives only the worker result and redacted `skill.run` status.

Activated Skill `allowed-tools` frontmatter is parsed and preserved for protocol fidelity and future policy tightening. In the current max-permission runtime, local tools already run as `auto`, so `allowed-tools` does not add permission beyond `client.hello.local_tools`, does not grant server tools, and never bypasses workspace containment. Current mappings remain intentionally small for when approval policies are reintroduced: `Read`/`List`/`Search` map to read-only `fs.*` tools, `Write` maps to `fs.write`, `Edit` maps to `fs.patch`, and `Bash(git:*)` matches only `shell.exec` commands whose first command token is `git`.

The tool call loop is:

```text
model tool_call
-> tool_call.delta requested
-> server tool execution or tool_call.request to the Desktop client
-> tool_call.result from the Desktop client when client-local
-> tool_call.delta completed/failed/cancelled
-> workspace.diff when a completed local write/patch returns file changes
-> Pi tool result appended to the Agent transcript
-> next model call or turn.completed
```

The current default runtime is max-permission: all declared client-local tools run as `auto`, so the normal user path emits no approval gate. `approval.request` and `approval.result` remain protocol event types only for a future restricted policy mode.

Run lifecycle state is streamed separately as `turn.state`: an accepted run first emits `queued`, then `running`, `waiting_for_tool`, `compacting`, `completed`, `failed`, or `cancelled` as the server-owned state machine transitions. Successful runs stream `turn.completed` before the terminal `turn.state: completed`, so clients can render the answer and then close the turn when the state machine completes.
`turn.cancel` is scoped to the target `run_id`: unknown runs return `unknown_run`, and cancellation never cancels pending tools for a different run on the same socket.
Cancelled runs terminate with `cancelled` and `run_cancelled`; they do not emit a secondary `run_failed`.

## Persistence

Runtime sessions, messages, run state transitions, tool calls, and emitted events are persisted as JSONL:

```text
.hatch-runtime/events.jsonl
```

Override the location with:

```bash
HATCH_RUNTIME_DATA_DIR=/path/to/runtime-data
```

The client declares its local tool capability once in `client.hello` with `local_tools`; duplicate `client.hello` messages on the same connection are rejected. Each `client.message` sends only the current user message plus `conversation_id`. The Consumer-selected workspace remains Desktop-only and is applied when the Desktop executes a local tool call. The server hydrates prior user/assistant messages from this store before each agent run.
Explicitly bound conversation history is namespaced by creator, user, Agent,
product, and Corpus digest. `GET /conversations/:id/messages` requires that
binding as query parameters, so an identical conversation ID under another
Agent Corpus cannot hydrate it.
`local_tools` is limited to local client capabilities (`fs.*`, `shell.exec`, `git.diff`). Server-side tools such as `web_search`, `api_request`, and `mcp_call` are owned and exposed by the server.
`tool_call.result` is accepted only after `client.hello` and only as a response to a pending `tool_call.request`; `status: ok` must include `result`, and `status: error` must include `error`.
Run-scoped `runtime.event` records and structured `tool.call` records include `conversation_id` when they occur inside a conversation run. Client-local tools are recorded by the broker, and server-local tools are recorded from the emitted `tool_call.delta` stream, so the append-only log can be audited by conversation without relying on client-side transcript state. Store appends are serialized per runtime store, and outbound protocol events are persisted as `runtime.event` before the server advances the next state transition.

## Context Compaction

Hatch follows Pi's implemented compaction model:

```text
old model-visible history
-> Pi's native compaction preparation and summary call
-> append conversation.compacted checkpoint to events.jsonl
-> replace active model-visible history with replacement_history
-> continue the original turn or next turn
```

The event log remains append-only. Old `message.created`, `tool.call`, and `runtime.event` records are not deleted or rewritten. `RuntimeStore.readConversation()` replays the log and, when it reaches a `conversation.compacted` event, replaces the active model-visible history with that checkpoint's `replacement_history`.

Compaction triggers:

```text
/compact                         manual standalone compaction turn
pre-turn auto compact             before appending the current user message
mid-turn auto compact             after a tool result before the next model call
```

Pi's native compaction prompt asks for a concise summary. The replacement history is the Pi-selected `compactionSummary` message followed by Pi's retained tail, including complete assistant tool-call/tool-result pairs. Base instructions, skill catalog, and any current-turn skill injections are still rebuilt separately by the server on every model call.

Auto compaction uses Pi's model profile context window and `DEFAULT_COMPACTION_SETTINGS`; there is no Hatch-specific token threshold or replacement-history truncation override.

## Run Locally

Start the Runtime server with:

```bash
npm run build
npm run serve
```

For local filesystem, shell, and Git operations, connect the Desktop/Tauri
client. The Runtime-side protocol boundary is `client.hello` plus
`client.message`, with local tool execution carried by
`tool_call.request`/`tool_call.result`; the Desktop client and Rust
`local-runner` own those operations.

## Configure The Runtime

The Registry is now also implemented in TypeScript in this package. Run it
separately from the Agent Runtime with `npm run serve:registry`; it owns Corpus
publish, current POSIX Corpus state, Postgres metadata, account access, and the
publish-time Qdrant ingestion hook. The two services share the TypeScript
Corpus contract but keep their HTTP processes separate.

Set the model and credentials in `.env`:

```text
HATCH_CREATOR_MODEL=kimi-k2.6
HATCH_REVIEWER_MODEL=kimi-k2.6
HATCH_COMPACTION_MODEL=kimi-k2.6
PORT=8400
LLM_API_KEY=...
OPENAI_BASE_URL=https://api.moonshot.cn/v1
HATCH_WEB_SEARCH_PROVIDER=bocha
HATCH_WEB_SEARCH_URL=https://api.bocha.cn/v1/web-search
HATCH_WEB_SEARCH_API_KEY=<server-side CWebSearch/Bocha key>
HATCH_MCP_SERVERS='{"docs":{"url":"https://example.com/mcp"}}'
HATCH_REGISTRY_URL=http://registry:8100
HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN=<runtime-service-token>
```

Spec v1 uses Kimi K2.6 exclusively for Creator execution, delivery review, and context compaction. Thinking is always enabled through Pi's normal thinking-level option; temperature follows the provider contract. Pi owns the model profile, context estimate, compaction policy, retries, and output behavior. There is no alternate-model fallback. Use Kimi's official `LLM_API_KEY` variable for credentials.
Corpus Evals are the default Creator quality gate. Ordinary Creator products stream Kimi's actual response to the Consumer Desktop. `HATCH_RUNTIME_DELIVERY_AUDIT=enforce` is an optional regulated-deployment override: it performs a second Kimi claim audit before delivery and intentionally withholds text streaming until that audit finishes.
`OPENAI_BASE_URL` falls back to `https://api.moonshot.cn/v1` and is restricted to official Moonshot endpoints (plus loopback test doubles). Use the `.ai` endpoint only with a matching international Kimi key. If any model override is present, it must be exactly `kimi-k2.6` or startup fails closed.
`HATCH_MCP_SERVERS` is optional. When set, the model can call `mcp_call`; the server sends MCP `tools/call` JSON-RPC requests and the client never sees MCP credentials.
`hatch.web_search` is a Hatch built-in tool. With `HATCH_WEB_SEARCH_PROVIDER=bocha`, Runtime uses the existing CWebSearch contract (`query`, `freshness`, `summary`, `count`) and normalizes Bocha's response to Hatch's stable `{ query, results }` shape. `HATCH_WEB_SEARCH_API_KEY` stays server-side and never enters the Agent Corpus or Desktop. Creator-owned HTTP/MCP tools are resolved exclusively through the Registry Control Plane using `HATCH_REGISTRY_URL` and `HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN`; the Runtime never reads connection URLs or credentials from the Corpus or local environment.

Then run:

```bash
npm run serve
```

## Protocol

Protocol version: `0.4`.

Assistant text from the single Shanghai cloud Runtime is released through
Alibaba AI Guardrails in delayed segments. It runs with
`HATCH_OUTPUT_GUARD=enforce` and `response_security_check_pro` on the Shanghai
VPC endpoint. Consumer Desktop never connects to a separate local Runtime. The
SDK uses the ECS RAM role credential chain; never place a long-lived Alibaba
AccessKey in Runtime configuration.

Canonical schema: `../packages/protocol/schemas/hatch-wire-protocol.schema.json`.

Inbound:

```text
client.hello
client.message
tool_call.result
turn.cancel
```

Default outbound:

```text
session.ready
turn.state
assistant.delta
session.compacted
skill.run
tool_call.delta
workspace.diff
tool_call.request
turn.completed
turn.failed
```

Future restricted-mode outbound schema entries:

```text
approval.request
approval.result
```

Execution surface:

```text
model-visible: Pi tools serialized through the OpenAI-compatible provider transport
server tools: web_search, api_request, mcp_call
client transport: file_list/file_search/file_read/file_write/file_patch/shell_exec/git_diff -> fs.*, shell.exec, git.diff
```
