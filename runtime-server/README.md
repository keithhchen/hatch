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

## Creator Releases

Set `HATCH_RELEASES_DIR` to a server-owned Release store. An explicit 0.3
`client.hello` binds `tenant_id`, `user_id`, `product_id`, `release_id`, and
`release_digest`. The Runtime resolves exactly
`$HATCH_RELEASES_DIR/<release_id>/<release_digest>/{public,private}.json`,
recomputes the canonical public/private digest, verifies every protected Skill
and RAG asset digest, and rejects product or identity mismatches. Contract v1
also rejects undeclared files and accepts only the exact five-file execution
package: `public.json`, `private.json`, `skills/<product-id>/SKILL.md`,
`rag/documents.json`, and `rag/chunks.json`. Factory review records, source
material, Evals, and traces never cross into Runtime. The private
system prompt and protected Skill root are materialized only in server memory;
only the public binding is returned in `session.ready`.

Local legacy harness sessions without explicit binding receive deterministic
local-UAT defaults. Published Release sessions must always send the explicit
binding and configure the Release store.

## Current Agent Corpus

The current publish path can resolve a runtime-free Corpus directly from
`HATCH_AGENT_CORPUS_ROOT/<creator_id>/<agent_id>`. A `client.hello` that carries
`creator_id` and `agent_id` loads that current Corpus without requiring a legacy
Creator Release. The server always loads `instructions/system.md`, activates
only the matching local Skill and its references, and never puts Evals into the
runtime context. The Corpus declares `hatch.web_search`; the retrieval tool is
exposed as `hatch.file_search` only when a knowledge provider is configured.

The production retrieval provider is Qdrant plus DashScope. Run Qdrant from
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

The runtime tracks protected skill execution on the event stream. The main agent receives public metadata and invokes `skill_run`; the server creates a headless `SkillRuntime` session that reads the private `SKILL.md`. The client sees `skill.run` status and brokered tool correlation, but never receives the worker prompt or raw transcript.

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

This package implements the Agent Skills protocol semantics over a Kimi K2.6 Chat Completions loop:

```text
startup context: skill name + description + public SKILL.md locator
selection: main agent calls `skill_run` with the public skill id and task
private execution: SkillRuntime loads the complete private SKILL.md inside a headless worker session
resource loading: the worker loads private skill resources on demand
tool execution: Chat Completions function calls mapped to server tools or brokered local tools
tool events: requested/completed/failed status streams as `tool_call.delta`; local writes can also stream `workspace.diff`
```

It does not expose `load_skill(skill_id)` as a model-visible tool. `skill_run` is the product runtime boundary: it is a normal Chat Completions function tool to the main agent, while the private skill body stays inside the server worker. The main agent cannot use `file_read` to load protected `SKILL.md` content.

Hatch does not use the Responses API or OpenAI hosted/local `shellTool`. Those are OpenAI implementation surfaces for mounting and executing skills. Hatch keeps the protocol portable by using OpenAI-compatible Chat Completions with function calling.

## Runtime Contract

The server builds base instructions for each model call from:

```text
system: runtime identity, security rules, and tool execution boundaries
user context: AGENTS.md project instructions loaded for the session
user context: server-rendered per-session Agent Skills catalog
worker context: private skill instructions inside SkillRuntime only
conversation: server-hydrated prior user/assistant messages
conversation: current user message
```

`client.hello` initializes the session skill context once: the server discovers skills, renders the catalog, loads project instructions, and stores that context on the WebSocket session. Later `client.message` turns reuse the same rendered catalog so the model-call prefix stays stable for prompt caching. New sessions discover again.

AGENTS.md project instructions use a `# AGENTS.md instructions ... <INSTRUCTIONS>` user-context shape. The public skill catalog is injected as server-authored `user` context prefixed with `HATCH RUNTIME CONTEXT`; private skill instructions are injected only into the worker context. Context compaction excludes rebuilt server context messages because the server reconstructs them from fixed session state.

Model-visible function tools are generated from the canonical runtime tool spec registry in `tools.ts`. Server tools are always owned by the runtime server. Client tools are exposed only when the `client.hello.local_tools` session capability says the local harness can execute them.
`file_read` and `file_list` are local workspace tools for the main agent. Protected skill resource paths are available only to SkillRuntime through the same ToolBridge and are never sent to the client as server-hosted skill content.
`shell_exec` accepts an optional `justification` field as model-visible reasoning context for the command. Local tools currently run with `auto` permission when the client declares the capability; the local Rust harness still enforces workspace containment and deterministic execution policy.
SkillRuntime loads the private `SKILL.md` and its resource manifest server-side. Relative paths under `references/`, `scripts/`, and `assets/` resolve against the worker's private skill directory. The main conversation receives only the worker result and redacted `skill.run` status.

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
Explicitly bound conversation history is namespaced by the complete tenant,
user, product, Release ID, and digest tuple. `GET /conversations/:id/messages`
requires those five values as query parameters (or `X-Hatch-*` headers), so an
identical conversation ID in another tenant or Release cannot hydrate it.
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
HATCH_MODEL_CONTEXT_WINDOW_TOKENS=256000   # auto compact at 90%
HATCH_AUTO_COMPACT_LIMIT_TOKENS=230400     # direct override
```

## Run Locally

Terminal 1:

```bash
npm run build
npm run serve
```

Terminal 2:

```bash
npm run client -- \
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
npm run client -- \
  --server ws://127.0.0.1:8400/runtime \
  --workspace /path/to/workspace
```

The same setting can be passed for a single run with `--rust-runner /path/to/hatch-local-runner`.

For one-shot scripted runs, pass `--prompt`:

```bash
npm run client -- --trace \
  --server ws://127.0.0.1:8400/runtime \
  --workspace /path/to/workspace \
  --prompt "Find Hatch. Save a summary."
```

For the connected V1 proof, the Consumer run is allowed to create an order
only after the exact immutable Release resolves as `published` from the live
Registry. The runner checks this before creating its output directory, Ledger,
order, or entitlement:

```bash
npm run proof:connected -- \
  --factory-root /absolute/path/to/completed-factory-output \
  --execute \
  --registry-url http://127.0.0.1:8100 \
  --output-root /absolute/path/to/empty-consumer-proof \
  --workspace-input /absolute/path/to/jordan-workspace \
  --prompt "Review my resume for the target role and save the completed review." \
  --rust-runner-bin /absolute/path/to/hatch-local-runner
```

The resulting `workflow-result.json` records both the Registry publication and
the later `order.placed` timestamp, so a post-hoc publication cannot make an
out-of-order demo appear connected.

Before publication, run the exact immutable Release against input-only held-out
cases through the real Runtime, live Kimi K2.6 candidate, and delivery audit.
The command independently resolves the Release digest, materializes the private
Skill/RAG/few-shots, opens normal entitlement-bound Runtime sessions, and writes
an atomic Factory-compatible `runtime-results.json`:

```bash
export LLM_API_KEY=... # inject at execution time; never commit it
npm run uat:release -- \
  --release /absolute/factory-root/release/<product-id>@<version>/sha256:<digest> \
  --inputs /absolute/factory-root/review/held-out-inputs.json \
  --output /absolute/factory-root/review/runtime-results.json \
  --workspace-input /absolute/path/to/seed-workspace \
  --profile-input /absolute/path/to/user-profile.md \
  --model-profile kimi-k2.6
```

Add `--preflight` to validate the exact Release, held-outs, workspace/profile
paths, delivery workflow, and Kimi-only profile without reading an API key or
making a network request. By default the executable creates a temporary exact
entitlement. To exercise an existing server-side entitlement projection, pass
all three together: `--entitlements <json> --license-token <opaque-token>
--entitlement-id <id>`. The entitlement must already pin the same Creator,
product, Release ID, and digest. `--rust-runner-bin <binary>` switches local
tool execution from the Node test harness to the production-shaped Rust
sidecar.

This runner does not reuse `semantic_uat` candidate outputs. Its report records
the exact server-pinned Release ID/digest, Kimi-only runtime profile, private
materialization proof (hash only), delivery-audit activation, and each
Consumer-visible result, workspace inputs, and observed local tool
requests/results. Local tool execution and artifact delivery are then
proved separately by `proof:connected` with the Rust runner and a fresh output
directory; an old proof directory is not valid evidence for a new Release.

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
HATCH_MODEL_CONTEXT_WINDOW_TOKENS=256000
HATCH_WEB_SEARCH_PROVIDER=bocha
HATCH_WEB_SEARCH_URL=https://api.bocha.cn/v1/web-search
HATCH_WEB_SEARCH_API_KEY=<server-side CWebSearch/Bocha key>
HATCH_MCP_SERVERS='{"docs":{"url":"https://example.com/mcp"}}'
HATCH_REGISTRY_URL=http://registry:8100
HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN=<runtime-service-token>
```

Spec v1 uses Kimi K2.6 exclusively for Creator execution and context compaction. Every call uses the live-verified non-thinking profile: `thinking: { type: "disabled" }` with `temperature=0.6`; omitting `thinking` makes Kimi enter its default reasoning mode and can consume the completion budget before returning a deliverable. There is no alternate-model fallback. Use Kimi's official `LLM_API_KEY` variable for credentials.
Release-level Evals are the default Creator quality gate. Ordinary Creator products stream Kimi's actual response to the Consumer Desktop. `HATCH_RUNTIME_DELIVERY_AUDIT=enforce` is an optional regulated-deployment override: it performs a second Kimi claim audit before delivery and intentionally withholds text streaming until that audit finishes.
`OPENAI_BASE_URL` falls back to `https://api.moonshot.cn/v1` and is restricted to official Moonshot endpoints (plus loopback test doubles). Use the `.ai` endpoint only with a matching international Kimi key. If any model override is present, it must be exactly `kimi-k2.6` or startup fails closed.
`HATCH_MCP_SERVERS` is optional. When set, the model can call `mcp_call`; the server sends MCP `tools/call` JSON-RPC requests and the client never sees MCP credentials.
`hatch.web_search` is a Hatch built-in tool. With `HATCH_WEB_SEARCH_PROVIDER=bocha`, Runtime uses the existing CWebSearch contract (`query`, `freshness`, `summary`, `count`) and normalizes Bocha's response to Hatch's stable `{ query, results }` shape. `HATCH_WEB_SEARCH_API_KEY` stays server-side and never enters the Agent Corpus or Desktop. Creator-owned HTTP/MCP tools are resolved exclusively through the Registry Control Plane using `HATCH_REGISTRY_URL` and `HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN`; the Runtime never reads connection URLs or credentials from the Corpus or local environment.

Then run:

```bash
npm run serve
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
model-visible: Chat Completions function tools
server tools: web_search, api_request, mcp_call
client transport: file_list/file_search/file_read/file_write/file_patch/shell_exec/git_diff -> fs.*, shell.exec, git.diff
```
