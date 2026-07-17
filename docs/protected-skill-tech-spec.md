# Protected Skill MVP Tech Spec

Status: implemented MVP
Scope: server-side protected skill execution with isolated worker and brokered tools  
Primary goal: protect private skill instructions from the main agent and client while preserving agentic tool use

## 1. Goal

Implement the minimum viable `protected_skill` runtime:

```text
main agent does not read full SKILL.md
client never receives full SKILL.md
server-side SkillRuntime reads full SKILL.md
SkillRuntime cannot execute tools directly
ToolBridge is the only tool gateway
MainAgentRuntime and SkillRuntime share the same app-level tool capabilities
SkillRuntime final output returns to main agent
main agent writes the user-facing answer
```

The first version does not try to make prompts unleakable. It reduces the blast radius:

```text
Before:
  user-facing main agent + private SKILL.md + user files share one context

After:
  main agent sees public manifest + skill.run result
  SkillRuntime sees private SKILL.md inside a scoped worker run
  client sees only redacted skill status and local tool requests
```

Important product assumption:

```text
The creator owns the whole agent runtime.
Skills are private modules inside that creator-owned app.
Therefore skill_run scope is not a smaller permission sandbox than main scope.
Both scopes share the same installed app capability envelope.
```

## 2. Non-Goals

Do not implement these in the MVP:

```text
forced output schema
schema validation / retry
private knowledge adapters
complex approval UI
worker trace UI
multi-worker scheduling
billing / licensing
creator marketplace flows
```

Worker output is not schema-enforced in this version. It may be plain text.

## 3. Components

```text
Runtime Server
  MainAgentRuntime
  SkillRegistry
  SkillRuntime
  ToolBridge
  SessionStore / ConversationStore

Desktop Client
  Chat UI
  LocalToolHarness
```

### MainAgentRuntime

Responsibilities:

```text
owns user-facing conversation loop
owns server-side session/history assembly
injects public skill catalog per session
exposes skill.run as a server-side tool
does not read private SKILL.md
receives SkillRuntime output
generates final user-facing assistant response
```

The protected main-agent catalog contains public metadata only. Its runtime
instructions direct the main agent to call `skill_run`; the main agent cannot
use `file_read` or another server path to load a protected skill body.

### SkillRegistry

Responsibilities:

```text
loads public skill manifests
locates private SKILL.md files
exposes optional expected tool hints
provides public catalog to MainAgentRuntime
provides private skill material to SkillRuntime only
```

SkillRegistry does not define a separate permission boundary for each skill. Skill manifests can describe expected tools for planning and UX, but enforcement belongs to the app-level capability policy in ToolBridge.

The server skill root uses the OpenAI Agent Skills file layout without adding a
Hatch-specific skill format. The vendored official-format fixtures are `pdf`,
`security-best-practices`, and `gh-fix-ci`; each retains `SKILL.md`, optional
`agents/openai.yaml`, and its upstream resources. Discovery reads only the
manifest and OpenAI metadata for the session catalog. Full instructions and
resources are loaded only when `SkillRuntime` executes `skill.run`.

### SkillRuntime

Responsibilities:

```text
creates a skill_run_id
spawns one complete headless agent session per skill.run
loads full private SKILL.md
runs an isolated worker LLM loop
emits tool intents
receives tool results from ToolBridge
returns final worker output to MainAgentRuntime
```

`SkillRuntime` is a real agent session, not an in-process helper function. Each
`skill.run` owns isolated worker state:

```text
worker message history
model-visible context
tool-call loop and pending tool state
context-compaction state and token budget
cancellation and failure state
trace and tool correlation ids
```

It is headless: it has no chat UI, no direct Desktop Client connection, and no
independent user-facing lifecycle. The parent `MainAgentRuntime` run creates,
cancels, and observes it through `skill_run_id`; only the parent run produces
the user-facing final answer.

SkillRuntime must not own:

```text
filesystem handles
network access
client sockets
raw API secrets
direct tool execution
```

### ToolBridge

Responsibilities:

```text
is the only tool execution gateway
validates main and skill_run tool intents
routes local tools to Desktop Client
executes server-side tools on the server
returns tool results to the correct runtime
records redacted visible tool state
```

ToolBridge enforces the installed creator app's capability envelope, not per-skill least privilege:

```text
scope = main
  same app-level capabilities

scope = skill_run
  same app-level capabilities

scope decides where the result returns.
scope does not reduce tool permissions.
```

Architecture invariant:

```text
Desktop Client only receives tool calls from ToolBridge.
MainAgentRuntime never sends tool calls directly to Desktop Client.
SkillRuntime never sends tool calls directly to Desktop Client.
```

### SessionStore / ConversationStore

This is not a new product concept. It means the existing server-side session and visible conversation persistence layer.

Responsibilities:

```text
persist user messages
persist assistant messages
persist redacted tool-call summaries
persist redacted skill.run status transitions
support chat reload with visible history
```

It must not expose client-visible records containing:

```text
full SKILL.md
worker system prompt
worker raw transcript
private references
private rubric
```

## 4. Skill Package

Minimum protected skill package:

```text
runtime-server/skills/review-contract/
  manifest.json
  SKILL.md
  references/
```

Example `manifest.json`:

```json
{
  "id": "review-contract",
  "name": "Contract Review",
  "description": "Review commercial contracts for negotiation risks.",
  "when_to_use": "Use for contract review, redline, negotiation, SaaS agreements.",
  "expected_tools": ["fs.read"],
  "visibility": "protected"
}
```

The public manifest may be shown to the main agent and UI. `SKILL.md` is private server-side material.

`expected_tools` is a planning and UI hint only. It is not an authorization boundary. Tool authorization comes from the installed creator app capability envelope.

Example app-level capabilities:

```json
{
  "app_id": "legal-review-agent",
  "tool_capabilities": [
    "fs.read",
    "fs.write",
    "shell.exec",
    "web.search",
    "private_knowledge.query"
  ]
}
```

## 5. Main Agent Contract

MainAgentRuntime receives a public catalog, not private skill text:

```text
Available protected skills:
- review-contract
  Description: Review commercial contracts for negotiation risks.
  When to use: Use for contract review, redline, negotiation, SaaS agreements.
  Invoke with: skill.run
```

Main agent tool:

```ts
type SkillRunArgs = {
  skill_id: string;
  task: string;
  context_refs?: string[];
};
```

Example call:

```json
{
  "skill_id": "review-contract",
  "task": "Review this SaaS agreement from the customer-side perspective.",
  "context_refs": [
    "local_file:legal-samples/acme-analytics-saas-agreement.md"
  ]
}
```

## 6. SkillRuntime Contract

SkillRuntime worker context contains:

```text
worker guard instructions
full private SKILL.md
task from main agent
context_refs from main agent
app-level tool schemas shared with MainAgentRuntime
```

Worker output is not schema-enforced in the MVP:

```ts
type SkillRunResult = {
  skill_id: string;
  skill_run_id: string;
  status: "completed" | "failed" | "cancelled";
  output?: string;
  error?: string;
};
```

The main agent receives this as the result of `skill.run`.

The `skill.run` tool is the invocation boundary. It is a normal Chat
Completions function tool from the main agent's point of view, but its executor
creates the headless `SkillSession` described above rather than running a plain
server helper function.

Minimal persisted worker-session state:

```ts
type SkillSession = {
  skill_run_id: string;
  parent_conversation_id: string;
  parent_run_id: string;
  skill_id: string;
  status: "running" | "waiting_for_tool" | "completed" | "failed" | "cancelled";
  messages: ModelMessage[];
};
```

`SkillSession` is server-private. Its raw `messages` and private trace are not
part of the visible conversation record. The visible conversation persists only
the redacted skill events listed below.

## 7. Tool Flow

All tools flow through ToolBridge:

```text
1. user sends message
2. MainAgentRuntime decides to call skill.run
3. server creates skill_run_id
4. SkillRuntime loads private SKILL.md
5. SkillRuntime emits a tool intent
6. ToolBridge validates the intent against app-level capabilities
7. ToolBridge routes:
   - fs.read / shell / git -> Desktop Client
   - web / API / server tools -> Runtime Server
8. ToolBridge returns the tool result to SkillRuntime
9. SkillRuntime continues or finishes
10. SkillRuntime final output returns as skill.run result
11. MainAgentRuntime replies to user
```

Worker-scoped tool intent:

```ts
type WorkerToolIntent = {
  scope: "skill_run";
  run_id: string;
  skill_run_id: string;
  tool_call_id: string;
  tool: string;
  arguments: Record<string, unknown>;
};
```

Example:

```json
{
  "scope": "skill_run",
  "run_id": "run_123",
  "skill_run_id": "skr_456",
  "tool_call_id": "wcall_1",
  "tool": "fs.read",
  "arguments": {
    "path": "legal-samples/acme-analytics-saas-agreement.md"
  }
}
```

Client-facing request from ToolBridge:

```json
{
  "type": "tool_call.request",
  "scope": "skill_run",
  "run_id": "run_123",
  "skill_run_id": "skr_456",
  "tool_call_id": "wcall_1",
  "tool": "fs.read",
  "arguments": {
    "path": "legal-samples/acme-analytics-saas-agreement.md"
  }
}
```

Client result:

```json
{
  "type": "tool_call.result",
  "scope": "skill_run",
  "run_id": "run_123",
  "skill_run_id": "skr_456",
  "tool_call_id": "wcall_1",
  "ok": true,
  "output": "..."
}
```

ToolBridge routes the result back to SkillRuntime by `scope` and `skill_run_id`.

The `scope` field is a routing/correlation field:

```text
scope = main
  return tool result to MainAgentRuntime

scope = skill_run
  return tool result to SkillRuntime
```

It is not a permission tier.

## 8. Visible UI Events

The chat UI should show skill usage at a product level:

```text
skill.run requested
skill.run running
skill.run completed
skill.run failed
skill.run cancelled
tool_call.delta with scope=skill_run
```

Example:

```json
{
  "type": "skill.run",
  "status": "running",
  "run_id": "run_123",
  "skill_run_id": "skr_456",
  "skill_id": "review-contract",
  "name": "Contract Review"
}
```

```json
{
  "type": "tool_call.delta",
  "scope": "skill_run",
  "status": "completed",
  "skill_run_id": "skr_456",
  "name": "file_read",
  "result": { "summary": "local tool result" }
}
```

The UI must not show:

```text
SKILL.md
worker system prompt
worker raw transcript
private references
private rubric
```

## 9. Persistence

SessionStore / ConversationStore should persist enough visible state to reload the chat:

```text
main user/assistant messages
skill.run requested/running/completed/failed/cancelled
redacted local tool summaries
skill.run result as seen by the main agent
```

The server also persists the private `SkillSession` independently so an
interrupted parent run can cancel or resume its worker safely. This is distinct
from visible chat-history persistence and must remain inaccessible to the
Desktop Client.

Session destruction is terminal and two-phase:

```text
worker completes/fails/cancels
  -> persist terminal SkillSession state
  -> abort pending LLM request and pending brokered tools
  -> release in-memory history, subscriptions, and tool correlation state
  -> keep the private terminal record for retention/recovery
```

When the parent run is cancelled or the client disconnects, the server aborts
the worker's `AbortSignal` and cancels its pending ToolBridge requests. A
terminal `skill_run_id` cannot be resumed or reused; retry creates a new
`skill_run_id`. Private worker transcripts/checkpoints are deleted later by the
server retention policy or immediately as part of conversation deletion. The
visible conversation keeps only redacted skill status and result state.

Reloaded chat history should show that a skill was used, but should not reveal private skill material.

## 10. Acceptance Criteria

MVP passes only if all are true:

```text
1. MainAgentRuntime messages do not contain full SKILL.md.
2. Desktop Client event stream does not contain full SKILL.md.
3. Reloaded visible conversation does not contain full SKILL.md.
4. MainAgentRuntime can see public skill catalog.
5. MainAgentRuntime can call skill.run.
6. skill.run starts SkillRuntime.
7. SkillRuntime can read private SKILL.md server-side.
8. MainAgentRuntime and SkillRuntime share the same app-level tool capability set.
9. SkillRuntime can request fs.read through ToolBridge when the app capability allows it.
10. Desktop Client executes the ToolBridge-issued fs.read request.
11. ToolBridge returns the fs.read result to SkillRuntime.
12. SkillRuntime final output returns to MainAgentRuntime.
13. MainAgentRuntime answers the user using SkillRuntime output.
14. Reloaded chat shows skill invoked/completed state.
15. Desktop Client never receives direct tool calls from MainAgentRuntime or SkillRuntime.
16. Skill manifest expected_tools is not used as an authorization boundary.
17. Every skill.run creates one isolated, server-private headless SkillSession.
18. SkillSession has its own worker history, tool-loop state, cancellation state, and compaction state.
19. SkillSession has no direct UI or Desktop Client connection; ToolBridge remains its only tool path.
20. Parent MainAgentRuntime owns the worker lifecycle and is the only runtime that writes a user-facing final answer.
21. Main-agent model requests cannot load protected `SKILL.md` through `file_read`.
22. The client receives worker tool correlation (`scope=skill_run`, `skill_run_id`) without receiving worker prompt or raw transcript.
```

## 10.1 Verification Matrix

Each acceptance item must have a direct assertion or an observable user-side
result. The protected runtime E2E uses a local OpenAI-compatible Chat
Completions stub, so it exercises the real server session, worker loop,
ToolBridge, store replay, and Local Harness protocol without depending on a
provider response shape.

```text
1.  Capture main model request; assert private marker is absent.
2.  Capture all outbound client events; assert private marker is absent.
3.  Call readVisibleConversation after completion; assert private marker absent.
4.  Assert main request contains public skill id/name/description only.
5.  Assert main request contains skill_run and the mock model invokes it.
6.  Assert skill.run events progress requested -> running -> completed.
7.  Assert worker model request contains the private marker.
8.  Compare main/worker model tool names; worker has the same app tools except skill_run recursion.
9.  Assert worker emits file_read through ToolBridge.
10. Assert the Local Harness receives scope=skill_run and executes file_read.
11. Assert the worker's next model request contains the returned local file content.
12. Assert the worker result is persisted and returned as the skill_run tool result.
13. Assert the main model receives that tool result and produces the final answer.
14. Assert reloaded visible history contains skill_runs.status=completed.
15. Assert no direct worker-to-client channel exists; worker tool events use ToolBridge correlation.
16. Set expected_tools to a hint that omits file_read; assert file_read still follows app capability policy.
17. Assert one unique skill_run_id and one private SkillSession per invocation.
18. Assert private session replay returns worker messages and terminal state; compaction replay replaces worker history.
19. Assert SkillRuntime has no socket/UI handle and only emits through the parent runtime callback.
20. Cancel the parent run; assert worker AbortSignal is triggered and parent alone emits the user-facing turn result.
21. Make the main model request file_read on the protected SKILL.md path; assert the runtime rejects it.
22. Assert local tool requests contain scope and skill_run_id, while model prompt/transcript is absent from outbound events.
23. Assert the bundled official-format skills are discovered from `SKILL.md`,
    their `agents/openai.yaml` interface metadata parses, and their full bodies
    do not appear in the public catalog.
24. Run a natural-language security review in the client; assert the model can
    select `security-best-practices`, the worker reads local files through
    `scope=skill_run`, and the client receives no worker prompt.
```

Required test commands:

```bash
cd runtime-server
pnpm run build
pnpm test
node --test --test-name-pattern='protected skill runs|cancelling the parent run' dist/runtime.e2e.test.js
node --test --test-name-pattern='vendored OpenAI-format|finish_reason arrives' dist/runtime.e2e.test.js
```

User-side acceptance uses the same legal workflow as the product scenario,
not an implementation-specific instruction:

```text
Review legal-samples/acme-analytics-saas-agreement.md from the customer side.
Prioritize customer data use, data protection/subprocessors, IP ownership,
indemnity, liability cap, auto-renewal, termination, and data deletion.
Return a prioritized risk list, redline direction, and fallback position.
Do not write a formal legal opinion; flag items for attorney review.
```

The operator verifies in the chat that the result is present, a local file
read is shown, and a skill run is shown as completed. On reconnect, the same
skill status and tool summary must remain visible. The debug event timeline is
checked separately for correlation IDs; it is not the product chat surface.

## 11. Implementation Order

```text
1. Add protected skill manifest loader.
2. Change main agent skill prompt to public catalog only.
3. Add server-side skill.run tool.
4. Implement SkillRuntime as a persisted headless worker session for a single skill.run.
5. Implement ToolBridge scope routing for main and skill_run with shared app-level capabilities.
6. Route skill_run fs.read through the existing Desktop Client local tool path.
7. Persist skill.run status and private SkillSession events in the existing store.
8. Update visible conversation reload to show skill run state.
9. Verify with review-contract + local legal sample.
```

## 12. First End-to-End Test Scenario

```text
User:
  Review legal-samples/acme-analytics-saas-agreement.md from the customer side.

Expected:
  MainAgentRuntime calls skill.run("review-contract").
  MainAgentRuntime does not read SKILL.md.
  SkillRuntime reads private SKILL.md.
  SkillRuntime requests fs.read through ToolBridge.
  Desktop Client reads the local contract file.
  SkillRuntime produces review output.
  MainAgentRuntime returns the user-facing answer.
  UI shows skill used and local file read summary.
  UI/reload never shows full SKILL.md.
```
