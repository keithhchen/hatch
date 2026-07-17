# Hatch TypeScript Runtime Server

This is the clean TypeScript implementation of the Hatch runtime loop:

```text
server agent runtime
  owns LLM calls, skill catalog, web/API tools

local harness
  owns filesystem, shell, git, workspace containment
```

The client never receives provider credentials and never imports an LLM SDK.
The TypeScript `localHarness` in this package is a scriptable dev/test harness for the wire protocol. The production local executor target is the Rust `local-runner`/Tauri sidecar: it should execute deterministic local tools only, while agent thinking, sessions, skill loading, and all LLM calls stay on the TypeScript server.
The canonical wire protocol schema lives in `../packages/protocol/schemas/hatch-wire-protocol.schema.json`; the server and Rust runner should mirror that schema until generated TS/Rust types are introduced.

## Install

```bash
pnpm install
```

## Build And Test

```bash
pnpm run build
pnpm run test
```

Tests inject a deterministic fake runtime where needed. The server entrypoint itself always uses the Chat Completions runtime.

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

`HATCH_SKILL_ROOTS` is a path-delimited list of creator/server-owned skill roots. Use it for local development or packaged creator app skills; do not rely on user workspace folders as implicit skill sources.

Project instructions are loaded from `AGENTS.md` files along the path from the detected project root to the current workspace root. In each directory, `AGENTS.override.md` wins over `AGENTS.md`; additional fallback filenames can be configured with `project_doc_fallback_filenames`. `project_root_markers` controls project-doc root detection only, not skill discovery. `project_doc_max_bytes` caps the total injected project-doc bytes, and `0` disables project-doc injection.

`agents/openai.yaml` is parsed for OpenAI Agent Skills metadata. `policy.allow_implicit_invocation: false` hides the skill from implicit model selection; explicit `$skill-name` mentions or linked `[$skill-name](/path/to/SKILL.md)` mentions still activate it for that turn. `policy.products` is enforced only when `HATCH_SKILL_PRODUCT` is set to `codex`, `chatgpt`, or `atlas`; by default product-restricted skills are not model-visible.

The runtime tracks skill invocation on the event stream. Explicit `$skill-name` or linked skill mentions emit `skill.activated` when the server injects that skill for the turn. Implicit use detected from a skill script run or `SKILL.md` read emits `skill.invoked` and persists `skill.invoked`. This records invocation without auto-injecting additional skill instructions; full instructions still arrive through progressive disclosure by reading `SKILL.md`.

The model-visible skills list follows Agent Skills progressive-disclosure budgeting: it uses at most 2% of a known model context window, or 8,000 characters when the context window is unknown. Set `HATCH_MODEL_CONTEXT_WINDOW_CHARS` when a provider exposes a known window. `HATCH_SKILL_METADATA_BUDGET_CHARS` can override the computed value for deterministic tests or constrained deployments.

`HATCH_SKILLS_CONFIG=/path/to/config.toml` can configure skills and project docs. `project_root_markers` controls `AGENTS.md` project-doc root detection. `include_instructions = false` suppresses the session skills catalog. `[skills.bundled].enabled = false` excludes bundled `runtime-server/skills`. `[[skills.config]]` entries configure individual skills by path or by skill name. Rules are applied in file order, so a later name selector can override an earlier path selector and vice versa:

```toml
project_root_markers = [".git"]
project_doc_fallback_filenames = ["PROJECT.md"]
project_doc_max_bytes = 32768

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

This package implements the Agent Skills protocol semantics over a model-agnostic Chat Completions loop:

```text
startup context: skill name + description + SKILL.md file locator
explicit activation: user `$skill-name` or linked `[$skill-name](/path/to/SKILL.md)` mentions are resolved by the server and injected before the model turn
implicit activation: model decides from visible skill descriptions and reads SKILL.md through file_read before acting; the server does not preselect a skill by description
resource loading: current-turn activated skill resources stay server-readable and are loaded on demand
tool execution: Chat Completions function calls mapped to server tools or brokered local tools
tool events: requested/completed/failed status streams as `tool_call.delta`; local writes can also stream `workspace.diff`
```

It does not expose `load_skill(skill_id)` as a model-visible tool. The skill catalog gives the model the same progressive-disclosure shape used by Agent Skills: metadata first, full `SKILL.md` only after selection, resources only when needed. Explicit `$skill-name` and linked `[$skill-name](/path/to/SKILL.md)` mentions are server-side invocation paths, not client-selected skill ids. Linked mentions select by exact `SKILL.md` path, which disambiguates same-named skills, and they do not fall back to plain-name activation when the linked path is missing.

Hatch does not use the Responses API or OpenAI hosted/local `shellTool`. Those are OpenAI implementation surfaces for mounting and executing skills. Hatch keeps the protocol portable by using OpenAI-compatible Chat Completions with function calling.

## Runtime Contract

The server builds base instructions for each model call from:

```text
system: runtime identity, security rules, and tool execution boundaries
user context: AGENTS.md project instructions loaded for the session
user context: server-rendered per-session Agent Skills catalog
user context: current-turn activated skill instructions
conversation: server-hydrated prior user/assistant messages
conversation: current user message
```

`client.hello` initializes the session skill context once: the server discovers skills, renders the catalog, loads project instructions, and stores that context on the WebSocket session. Later `client.message` turns reuse the same rendered catalog so the model-call prefix stays stable for prompt caching. New sessions discover again.

AGENTS.md project instructions use a `# AGENTS.md instructions ... <INSTRUCTIONS>` user-context shape. Skill catalog and current-turn activated skill instructions are injected as server-authored `user` context messages prefixed with `HATCH RUNTIME CONTEXT`. They are deliberately not system instructions: the system prompt keeps only runtime/security/tool boundaries, while project docs and skill content remain task context with ordinary user-message priority. Context compaction excludes these server context messages because the server rebuilds them on every model call from the fixed session context.

Model-visible function tools are generated from the canonical runtime tool spec registry in `tools.ts`. Server tools are always owned by the runtime server. Client tools are exposed only when the `client.hello.local_tools` session capability says the local harness can execute them.
`file_read` and `file_list` are hybrid specs: server-hosted Skill resource paths execute on the server; workspace paths require the matching local client capability.
`shell_exec` accepts an optional `justification` field as model-visible reasoning context for the command. Local tools currently run with `auto` permission when the client declares the capability; the local Rust harness still enforces workspace containment and deterministic execution policy.
When a server-hosted `SKILL.md` is read successfully, the `file_read` result includes the skill directory plus a resource manifest for files under `references/`, `scripts/`, and `assets/` without reading those files eagerly. Resource manifests are capped at 200 files and include a truncation flag when more files exist. The runtime records a `skill.activated` audit event, and the full instructions are available only for the current turn unless the skill is re-mentioned or read again. Explicitly mentioned skills are injected in a `<skill><name>...</name><path>...</path>...</skill>` block with the full `SKILL.md` instructions and the same `<skill_resources>` manifest. A model-driven `file_read` of `SKILL.md` also returns the complete resource. Relative paths under `references/`, `scripts/`, and `assets/` resolve against the current-turn activated skill directory; if multiple activated skills match the same relative path, the model must use the full skill resource path. This preserves Agent Skills progressive disclosure across multi-turn Chat Completions sessions without carrying skill bodies across turns.

Activated Skill `allowed-tools` frontmatter is parsed and preserved for protocol fidelity and future policy tightening. In the current max-permission runtime, local tools already run as `auto`, so `allowed-tools` does not add permission beyond `client.hello.local_tools`, does not grant server tools, and never bypasses workspace containment. Current mappings remain intentionally small for when approval policies are reintroduced: `Read`/`List`/`Search` map to read-only `fs.*` tools, `Write` maps to `fs.write`, `Edit` maps to `fs.patch`, and `Bash(git:*)` matches only `shell.exec` commands whose first command token is `git`.

The tool call loop is:

```text
model tool_call
-> tool_call.delta requested
-> server tool execution or tool_call.request to local harness
-> tool_call.result from local harness when client-local
-> tool_call.delta completed/failed/cancelled
-> workspace.diff when a completed local write/patch returns file changes
-> tool result message appended back into Chat Completions
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

The client declares local workspace capability once in `client.hello` with `workspace_root` and `local_tools`; duplicate `client.hello` messages on the same connection are rejected so capability cannot be reset mid-session. Each `client.message` sends only the current user message plus `conversation_id`. `local_tools: []` is allowed for a no-local-workspace session; any declared `fs.*`, `shell.exec`, or `git.diff` capability requires `workspace_root`. The server hydrates prior user/assistant messages from this store before each agent run.
`local_tools` is limited to local client capabilities (`fs.*`, `shell.exec`, `git.diff`). Server-side tools such as `web_search`, `api_request`, and `mcp_call` are owned and exposed by the server.
`tool_call.result` is accepted only after `client.hello` and only as a response to a pending `tool_call.request`; `status: ok` must include `result`, and `status: error` must include `error`.
Run-scoped `runtime.event` records and structured `tool.call` records include `conversation_id` when they occur inside a conversation run. Client-local tools are recorded by the broker, and server-local tools are recorded from the emitted `tool_call.delta` stream, so the append-only log can be audited by conversation without relying on client-side transcript state. Store appends are serialized per runtime store, and outbound protocol events are persisted as `runtime.event` before the server advances the next state transition.

## Context Compaction

Hatch follows the Codex-style compaction model over Chat Completions:

```text
old model-visible history
-> special compaction LLM call
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

The compaction prompt asks for a concise handoff summary. The replacement history keeps recent real user messages up to about 20,000 estimated tokens, then appends a `user` message prefixed with `CONTEXT CHECKPOINT COMPACTION`. Base instructions, skill catalog, and any current-turn skill injections are still rebuilt separately by the server on every model call.

Auto compaction is enabled when a context limit is configured:

```text
HATCH_MODEL_CONTEXT_WINDOW_TOKENS=128000   # auto compact at 90%
HATCH_AUTO_COMPACT_LIMIT_TOKENS=115200     # direct override
HATCH_COMPACTION_MODEL=kimi-k2.6           # optional summary model
```

## Run Locally

Terminal 1:

```bash
pnpm run build
pnpm run serve
```

Terminal 2:

```bash
pnpm run client -- \
  --server ws://127.0.0.1:8400/runtime \
  --workspace /path/to/workspace \
  --conversation my-session
```

This opens an interactive chat:

```text
you> Read README.md and summarize it.
assistant> ...
tools> shell.exec
```

The dev harness declares the full local tool set by default, including `shell.exec`. Pass `--no-shell` only when you need to simulate a restricted local client.

Use `/exit` or `/quit` to close the chat.

By default this package's dev harness executes local tools with Node.js so tests can run without the desktop app. To run the production-shaped local path, point the harness at the Rust sidecar:

```bash
cargo build --manifest-path ../local-runner/Cargo.toml
export HATCH_LOCAL_RUNNER_BIN=../local-runner/target/debug/hatch-local-runner
pnpm run client -- \
  --server ws://127.0.0.1:8400/runtime \
  --workspace /path/to/workspace
```

The same setting can be passed for a single run with `--rust-runner /path/to/hatch-local-runner`.

For one-shot scripted runs, pass `--prompt`:

```bash
pnpm run client -- --trace \
  --server ws://127.0.0.1:8400/runtime \
  --workspace /path/to/workspace \
  --prompt "Find Hatch. Save a summary."
```

## Configure The Runtime

Set the model and credentials in `.env`:

```text
HATCH_CREATOR_MODEL=kimi-k2.6
PORT=8400
MOONSHOT_API_KEY=...
OPENAI_BASE_URL=https://api.moonshot.cn/v1
HATCH_MODEL_CONTEXT_WINDOW_TOKENS=256000
HATCH_MCP_SERVERS='{"docs":{"url":"https://example.com/mcp"}}'
```

Kimi K2.6 is the default because it is OpenAI-compatible and supports multimodal input.
Use Kimi's official `MOONSHOT_API_KEY` variable for Kimi credentials. The runtime also accepts `OPENAI_API_KEY` as a compatibility fallback for other OpenAI-compatible providers.
`OPENAI_BASE_URL` falls back to `https://api.moonshot.cn/v1`, but keep it explicit in `.env` so provider changes are obvious. Use the `.ai` endpoint only with a matching international Kimi key.
`HATCH_MCP_SERVERS` is optional. When set, the model can call `mcp_call`; the server sends MCP `tools/call` JSON-RPC requests and the client never sees MCP credentials.

Then run:

```bash
pnpm run serve
```

## Protocol

Protocol version: `0.3`.

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
skill.activated
skill.invoked
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
model-visible: Chat Completions function tools
server tools: web_search, api_request, mcp_call
client transport: file_list/file_search/file_read/file_write/file_patch/shell_exec/git_diff -> fs.*, shell.exec, git.diff
```
