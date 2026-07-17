# Protected Skill MVP Tech Spec

Status: design draft  
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

### SkillRegistry

Responsibilities:

```text
loads public skill manifests
locates private SKILL.md files
defines allowed tools per skill
provides public catalog to MainAgentRuntime
provides private skill material to SkillRuntime only
```

### SkillRuntime

Responsibilities:

```text
creates a skill_run_id
loads full private SKILL.md
runs an isolated worker LLM loop
emits tool intents
receives tool results from ToolBridge
returns final worker output to MainAgentRuntime
```

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
persist skill.invoked / skill.completed / skill.failed
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
  "allowed_tools": ["fs.read"],
  "visibility": "protected"
}
```

The public manifest may be shown to the main agent and UI. `SKILL.md` is private server-side material.

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
allowed tool schemas
```

Worker output is not schema-enforced in the MVP:

```ts
type SkillRunResult = {
  skill_id: string;
  skill_run_id: string;
  status: "completed" | "failed";
  output?: string;
  error?: string;
};
```

The main agent receives this as the result of `skill.run`.

## 7. Tool Flow

All tools flow through ToolBridge:

```text
1. user sends message
2. MainAgentRuntime decides to call skill.run
3. server creates skill_run_id
4. SkillRuntime loads private SKILL.md
5. SkillRuntime emits a tool intent
6. ToolBridge validates the intent
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

## 8. Visible UI Events

The chat UI should show skill usage at a product level:

```text
skill.invoked
skill.progress
skill.tool_summary
skill.completed
skill.failed
```

Example:

```json
{
  "type": "skill.invoked",
  "skill_id": "review-contract",
  "skill_run_id": "skr_456",
  "name": "Contract Review"
}
```

```json
{
  "type": "skill.tool_summary",
  "skill_run_id": "skr_456",
  "summary": "Read local contract file legal-samples/acme-analytics-saas-agreement.md"
}
```

```json
{
  "type": "skill.completed",
  "skill_id": "review-contract",
  "skill_run_id": "skr_456"
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
skill.invoked
skill.progress summaries
skill.completed / skill.failed
redacted local tool summaries
skill.run result as seen by the main agent
```

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
8. SkillRuntime can request fs.read through ToolBridge.
9. Desktop Client executes the ToolBridge-issued fs.read request.
10. ToolBridge returns the fs.read result to SkillRuntime.
11. SkillRuntime final output returns to MainAgentRuntime.
12. MainAgentRuntime answers the user using SkillRuntime output.
13. Reloaded chat shows skill invoked/completed state.
14. Desktop Client never receives direct tool calls from MainAgentRuntime or SkillRuntime.
```

## 11. Implementation Order

```text
1. Add protected skill manifest loader.
2. Change main agent skill prompt to public catalog only.
3. Add server-side skill.run tool.
4. Implement SkillRuntime for a single worker run.
5. Implement ToolBridge scope routing for main and skill_run.
6. Route skill_run fs.read through the existing Desktop Client local tool path.
7. Persist skill.invoked / skill.completed / skill.failed in existing store.
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

