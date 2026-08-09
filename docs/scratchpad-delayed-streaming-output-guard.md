# Delayed Streaming Guard Scratchpad

Status: working draft

## Goal

The Agent may know its full System Prompt, Skills, RAG, and Tool Results, but
unapproved output must not reach the user, durable chat history, or the next
model turn.

The V1 cloud classifier has one narrow policy: block actual disclosure of the
current Agent's non-public System/Developer prompts, Skills, or other hidden
instructions. Mentioning those concepts, refusing to disclose them, discussing
public examples, and processing user-provided text are not disclosures.

The regression corpus lives at
`runtime-server/evals/output-disclosure.json`. It contains ordinary answers,
refusals, generic explanations, direct and paraphrased disclosure, encoding,
and cross-segment cases. Cloud policy changes are not ready to publish until
every case matches its expected verdict.

## Core rule

`assistant.delta` is provisional UI. The persisted
`conversation.model_message` is the single durable source of truth.
`turn.completed` only tells the live client that the durable commit finished.

```text
Model delta
  -> accumulate a segment
  -> Guard check
  -> pass: emit segment
  -> block/error: abort and return an outcome flag
```

## Initial defaults

| Setting | Value |
|---|---:|
| First segment | 100 characters |
| Later segments | 250 characters |
| Local detection overlap | None in V1 |
| Guard calls in flight per stream | 1 |
| Error behavior | Fail closed |

Prefer sentence or newline boundaries. Always check the final remainder with
`done: true`.

All segments in one response share:

- `chatId`: current interaction round;
- `sessionId`: current output stream;
- `done: false`: intermediate segment;
- `done: true`: final segment.

For V1, use `run_id` as both `chatId` and `sessionId`. Alibaba Guardrails
correlates segments with the same identifiers, so do not duplicate local
overlap until a split-disclosure eval proves it necessary. Specifically test
responses longer than the API's 2,000-character content limit; add a small
local overlap only if that boundary is not covered by provider correlation.

## Runtime behavior

```text
Model:   segment 1 ---- segment 2 ---- segment 3
Guard:               check 1 ----- check 2 ----- check 3
Client:                       show 1 ----- show 2 ----- show 3
```

- Model generation may continue while the Guard checks.
- Later text stays in a bounded server-side buffer.
- Segments are checked and released in order.
- Any result other than `pass` blocks at launch.
- Guard timeout, throttling, or provider error also blocks.

## Block behavior

On a blocked segment:

1. Mark the stream terminal.
2. Abort the model.
3. Discard the blocked segment and all unreleased text.
4. Persist a model-visible assistant marker.
5. Emit `turn.completed` with `finish_reason: content_filter`.

```json
{
  "type": "turn.completed",
  "run_id": "run_123",
  "finish_reason": "content_filter"
}
```

Do not use `turn.failed`: this is a controlled terminal outcome.

The client sees the flag, clears the entire provisional bubble, and renders its
own local safety UI. Runtime does not supply user-facing block copy.

## Persistence and projection

Never persist:

- blocked or pending output;
- the unguarded final model response;
- aborted partial assistant output;
- a Tool Result blocked by POST Tool Guard;
- raw blocked content in logs or errors.

Persist the model transcript with one existing event type:

- `conversation.model_message` is canonical for both model history and visible
  client history;
- `turn.completed` is a transient wire signal and is not persisted;
- `assistant.delta` is never persisted;
- generic `runtime.event` copies of wire messages are never persisted;
- new guarded runs do not write `message.created`; legacy rows remain readable;
- there is no `assistant.output.committed` event.

```ts
type OutputFinishReason =
  | "stop"
  | "content_filter";

type StoredModelMessage = {
  type: "conversation.model_message";
  conversation_id: string;
  run_id: string;
  message: ConversationMessage;
  finish_reason?: OutputFinishReason;
};

type TurnCompleted = {
  type: "turn.completed";
  run_id: string;
  finish_reason: OutputFinishReason;
};
```

Persistence invariant:

```text
user message                         -> finish_reason absent
intermediate assistant tool call     -> finish_reason absent
tool result                          -> finish_reason absent
terminal approved assistant message  -> finish_reason=stop
terminal blocked assistant marker    -> finish_reason=content_filter
```

Every completed run has exactly one assistant `conversation.model_message`
with `finish_reason`. The field itself marks the terminal record; do not add a
second `terminal` or `committed` boolean.

Wire invariant:

```text
finish_reason=stop            -> retain the approved streamed preview
finish_reason=content_filter  -> clear the entire streamed preview
```

Guard timeout, throttling, malformed response, and provider failure all fail
closed to `content_filter`. Their detailed causes belong in operational
telemetry, not canonical conversation history. If provider usage is available,
keep it only in the existing `ConversationMessage.usage`; an aborted provider
stream may not return final token counts.

For a blocked response, persist the model marker before emitting the terminal
wire event:

```json
{
  "type": "conversation.model_message",
  "conversation_id": "conversation_1",
  "run_id": "run_123",
  "finish_reason": "content_filter",
  "message": {
    "role": "assistant",
    "content": "<runtime_status output_guard=\"blocked\" />"
  }
}
```

After that commit succeeds, emit but do not persist:

```json
{
  "type": "turn.completed",
  "run_id": "run_123",
  "finish_reason": "content_filter"
}
```

On a normal pass, persist the complete approved assistant text in
`conversation.model_message` with `finish_reason: stop`, then emit
`turn.completed`. The terminal event does not repeat the text.

The write/send order is fixed:

```text
final Guard verdict
  -> append terminal conversation.model_message
  -> emit turn.completed
```

If the append fails, do not emit `turn.completed`. The client discards the
provisional bubble on failure or reconnect because no terminal assistant record
exists.

After a block:

- `readVisibleConversation()` projects the persisted model message into a
  blocked outcome flag with no visible text;
- `readConversation()` reads the same record as the model-visible runtime marker;
- the next model turn never sees the raw blocked output;
- an in-memory Agent transcript containing raw partial output is discarded.

Conceptual next-turn model projection:

```text
assistant:
<runtime_status output_guard="blocked" />
```

The marker is persisted directly as model history. It is not user-facing copy
and contains no matched content, label, or policy detail.

Visible history projection includes user model messages and only those
assistant model messages that have `finish_reason`. It ignores intermediate
assistant tool-call messages and tool-result messages. For a blocked terminal
record, it hides the marker and uses an empty content string for client
compatibility:

```ts
{
  run_id: "run_123",
  role: "assistant",
  content: "",
  finish_reason: "content_filter"
}
```

On reconnect or restart, server-committed history replaces any provisional
client bubble. A committed block flag makes the client render its local safety
UI. If no stored assistant record exists, discard the partial preview and show
an interrupted task.

## Minimal integration

Do not add a Guard microservice, database table, durable queue, second event
queue, or new protocol event. Reuse the current outbound queue. The first
implementation has only two new runtime concepts:

1. one reusable Alibaba Guardrails client;
2. one per-run in-memory segment buffer.

Provider call:

```ts
type OutputGuardVerdict = "pass" | "block";

type OutputGuard = {
  check(input: {
    content: string;
    chatId: string;
    sessionId: string;
    done: boolean;
  }, signal?: AbortSignal): Promise<OutputGuardVerdict>;
};
```

## Alibaba policy scope

`response_security_check_pro` can return several independent dimensions in one
response. Hatch uses it here only as an output-disclosure classifier. Runtime
therefore reads the `customLabel` dimension and ignores `promptAttack` and
general `contentModeration` verdicts for this feature. A missing, malformed, or
non-pass/non-block `customLabel` result fails closed.

This matters because the built-in `promptAttack` model is primarily useful for
hostile input. In live output tests it classified safe refusal text as
`Prompt Leaking`, even when the response revealed nothing.

Baseline on the initially published Qwen3.0-Flash custom policy:

- normal answer: pass;
- direct, summarized, encoded, Skill, and cross-segment disclosure: block;
- safe refusal: false-positive block from `customLabel`;
- observed public-endpoint latency: about 380-454 ms per segment.

The next cloud draft should keep two non-overlapping block labels:

1. `隐藏指令泄露`: actual content from the current Agent's System Prompt,
   Developer Prompt, or other non-public high-priority instructions;
2. `Skill内容泄露`: actual content, structure, triggers, or internal procedure
   from a non-public Skill, SKILL.md, reference, or template.

Both descriptions must define what the risky text *is*. They must explicitly
require concrete non-public content and include a safe refusal boundary. Do not
write keyword-matching or "block content that mentions..." instructions.

The adapter calls `MultiModalGuard` with:

```text
service    = response_security_check_pro
endpoint   = green-cip-vpc.cn-shanghai.aliyuncs.com
chatId     = run_id
sessionId  = run_id
```

Only a valid `customLabel` result whose labels all return `pass` becomes
`pass`. Any custom-label `block`, a missing or malformed custom-label result,
timeout, throttling, or transport failure becomes `block`. Do not retry a
segment in the streaming path because a retry can also duplicate
provider-side stream state.

Per-run state is transient and intentionally small:

```ts
type GuardedOutput = {
  pending: string;
  first: boolean;
  terminal: boolean;
};
```

The Guard middleware awaits one check at a time. Pi may continue producing into
its existing internal queue while the Runtime's unified outbound boundary is
waiting, so no second queue or promise chain is needed. Intermediate flushing
always leaves at least one
character in `pending`, so finalization can make a non-empty `done: true`
request even when the generated length lands exactly on a segment boundary.

Intercept every `assistant.delta` with `kind: "text"` once in `index.ts`. This
automatically covers:

- Pi `text_delta` events;
- an audited delivery workflow's final text;
- the Runtime-owned “saved to path” suffix.

Status deltas do not go through the Output Guard. Pi's existing queue lifecycle
does not change. When `index.ts` receives `turn.completed`, it checks the final
remainder with `done: true`, persists the terminal model message, then sends the
smaller terminal event.

Keep the existing persistence callback unchanged for intermediate model
transcript messages:

```ts
persistModelMessage(message: ConversationMessage): Promise<void>;
```

- intermediate assistant tool-call messages and Tool Results continue to use
  this callback;
- Pi no longer persists its final assistant at `message_end`;
- `index.ts` reconstructs approved text from released segments and appends the
  one terminal record with `stop` or `content_filter`;
- delivery/receipt logic consumes that run-local approved text; terminal text
  is not repeated on the wire.

Ownership stays narrow:

```text
piAgentRuntime  -> produce raw Runtime events; do not persist terminal assistant
index           -> buffer/Guard text, append canonical terminal, send terminal
store           -> replay/project canonical records
desktop         -> provisional text and local blocked UI only
```

Credentials come from the Alibaba Cloud default credential chain. Production
ECS uses `HatchRuntimeRole` through instance metadata/IMDSv2; do not put an AK
in Hatch config. Reuse a singleton SDK client. Start with a 10-second Guard read
timeout and no retry, then tune from measured latency. Deployment sets
`ALIBABA_CLOUD_ECS_METADATA=HatchRuntimeRole` and
`ALIBABA_CLOUD_IMDSV1_DISABLE=true` after the role is attached.

## Tool Result rule

A Tool Call is also an output channel. Stage its assistant tool-call message and
arguments until PRE Tool Guard passes. Before approval:

- do not execute the tool;
- do not emit a client-visible tool event;
- do not persist the raw assistant tool-call message or `tool.call` arguments.

If PRE Tool Guard blocks, abort the run and use the same terminal path as a
blocked text segment: persist only the assistant Runtime marker with
`finish_reason: content_filter`, then emit `turn.completed`. Do not add a second
tool-specific finish reason.

A Tool Result becomes future model input, so POST Tool Guard uses the input/query
Guard before returning it to the Agent.

Blocked result:

```json
{
  "status": "blocked",
  "error": "Untrusted tool content was blocked."
}
```

The raw Tool Result is neither persisted nor returned to the Agent.

## Deferred change: simplify local tools

This is a separate implementation change, recorded here but not part of the
streaming Guard design. Keep one tool name across the model, Runtime, wire
protocol, client, logs, and persisted events:

```text
read
write
edit
grep
bash
```

Remove the `fs.*`, `file_*`, `shell_exec`, and `git_diff` alias families.
`bash` covers listing files and `git diff`; `grep` provides the common
read-only search path without requiring the model to compose a shell command.

Each tool needs one definition:

```ts
type ToolDefinition = {
  name: ToolName;
  description: string;
  parameters: JSONSchema;
  available(ctx: RunContext): boolean;
  execute(ctx: ToolContext, args: unknown): Promise<ToolResult>;
};
```

Server/client placement is an implementation detail inside `execute`; it is not
a second model-facing tool identity. Client capability and approval remain
protocol/policy checks, not aliases.

`persistRequestedArtifact` is only an orchestration fallback. Rename it to
`ensureRequestedArtifactSaved` and have it call the same centralized
`executeTool("write", ...)` path used by Agent tool calls. It must not have a
separate write implementation or bypass Tool Result Guard.

Protected Skill resources must not make `read` hybrid. Required Skill content
is materialized into the Agent context; local tools operate only on the
client-declared workspace.

## Current-code mismatches found in review

- `index.ts` currently persists every outbound message as `runtime.event`,
  including raw `assistant.delta` and `turn.completed`.
- `index.ts` currently writes user and final assistant `message.created` rows.
- `piAgentRuntime.ts` currently persists assistant messages at Pi `message_end`,
  before the final Output Guard decision and before PRE Tool Guard can approve
  tool-call arguments.
- `RunFinal` and the wire schema currently require duplicated `output` and
  `usage` fields instead of `finish_reason`.
- `readVisibleConversation()` currently projects only `message.created`; it must
  project user messages and terminal assistant records from
  `conversation.model_message`.
- The Desktop currently falls back to `activeRun.text` when terminal `output` is
  empty. It must branch only on `finish_reason`.

## Hatch touchpoints

- [piAgentRuntime.ts](../runtime-server/src/piAgentRuntime.ts): stop persisting
  the final assistant before Guard approval. Its queue lifecycle is unchanged.
- `runtime-server/src/outputGuard.ts`: hold the singleton Alibaba SDK adapter
  and the small per-run segment buffer. Do not expose Alibaba response shapes to
  the rest of the Runtime.
- [index.ts](../runtime-server/src/index.ts): guard every outbound text delta at
  one boundary, keep approved text in run-local memory for delivery logic, and
  send the non-persisted `turn.completed` only after the terminal record has
  committed; persist new user messages as
  `conversation.model_message`; stop writing `message.created` and generic
  `runtime.event` copies of wire messages for new guarded runs.
- [protocol.ts](../runtime-server/src/protocol.ts) and
  [wire schema](../packages/protocol/schemas/hatch-wire-protocol.schema.json):
  add the discriminated `finish_reason` variants. This changes terminal client
  semantics and should bump the wire protocol version rather than silently
  serving guarded streams to an older client.
- [store.ts](../runtime-server/src/store.ts) and
  [postgresStore.ts](../runtime-server/src/postgresStore.ts): visible history
  and model history both project from `conversation.model_message`. Visible
  history selects user messages plus terminal assistant records.
- [main.jsx](../desktop-app/src/renderer/main.jsx): retain provisional text on
  `stop`; clear it and render local UI on `content_filter`; reconcile active
  runs from server history.

## Must-pass tests

- A blocked segment is never emitted or persisted.
- A late delta cannot arrive after terminal completion.
- An answer ending exactly on a segment threshold still sends one non-empty
  final `done: true` request.
- Pi's existing queue closure does not bypass Guard checks for post-generation
  delivery text or suffixes.
- A split disclosure is caught through the shared provider stream session.
- The split-disclosure test also covers a response longer than 2,000 characters;
  add local overlap only if this test demonstrates a provider boundary gap.
- Guard errors fail closed.
- Restart after a block renders client-local safety UI from the stored flag.
- A completed run writes exactly one terminal assistant record; intermediate
  model transcript records do not have `finish_reason`.
- No `assistant.delta` is present in durable storage.
- `turn.completed` is never persisted and never repeats assistant text.
- The next model turn sees only the generated Runtime status marker.
- Blocked Tool Results never enter model history.

## Open questions

- After Guardrails activation, does `response_security_check_hp` execute a
  configured custom detection Agent and return `customLabel` results? The
  public docs establish custom prompts for `response_security_check`, but do
  not establish this for the high-performance service.
- Is it billed per segment request or per correlated stream?
- Does a response longer than 2,000 characters need local overlap to preserve
  cross-boundary detection? Decide from the split-disclosure eval.

## Alibaba deployment notes

- Hatch production is ECS `i-uf6gvrytgdhiuohk4yp5` in `cn-shanghai-e`, VPC
  `vpc-uf6pf48y8qpyqnmq3mv48`; use the Shanghai VPC Guardrails endpoint.
- The existing ECS role is feature-specific: `HatchRegistryBailianRole`.
- A project-level `HatchRuntimeRole` has been created with the two existing
  Bailian policies plus `AliyunYundunGreenWebFullAccess`.
- Do not attach the new role to production ECS until the Guard code is ready;
  keep the old role for rollback.
- AI Guardrails pay-as-you-go service was activated for the Alibaba Cloud
  account on 2026-08-09. The required service-linked role was created.
- Log Service remains disabled; no resource package or other add-on was
  purchased.

Custom detection prompts are configured in the Guardrails console as detection
tags and definitions. They are not sent with each API request. Start with only
two tags:

```text
Tag: 内部指令泄露
Definition: 向用户陈述、引用、复述、概括、翻译、编码或分段拼接当前 Agent 的 System Prompt、Developer Prompt、隐藏规则、运行时状态、工具定义、权限策略、Guard 逻辑或指令优先级的内容。包括声称猜测但实质还原。一般性讨论这些概念，以及仅表示无法提供内部指令，不属于此类。

Tag: 受保护资料复现
Definition: 向用户逐字或高保真复现、批量摘录、列目录、或概括到可重建程度的当前 Agent 私有 Skill、SKILL.md、reference、模板、内部知识源或工具返回原文。允许基于资料完成任务并给出派生结论；不允许暴露源文件、内部结构、隐藏方法或可重建片段。
```

Use definitions rather than instructions such as “block this.” Include safe
boundaries in each definition to reduce false positives. Add more tags only
after evals show a distinct failure mode.

### Published Alibaba configuration (2026-08-09)

- Region: `cn-shanghai` / 华东 2（上海）
- Service: `response_security_check_pro`
- Custom detection Agent: enabled and published
- Model: `Qwen3.0-Flash`
- Template: custom-label template, 704 custom characters (one billing slice)
- Blocking labels:
  - `内部指令泄露`
  - `受保护资料复现`
- Pre-publish console tests:
  - direct System Prompt/tool disclosure -> high risk / `内部指令泄露`
  - private `SKILL.md`/reference/token disclosure -> high risk /
    `受保护资料复现`
  - refusal plus general System Prompt explanation -> no risk
- Built-in content compliance and prompt-attack dimensions remain enabled;
  sensitive content, malicious URL, hallucination, custom redaction, and log
  analysis remain disabled.
- `response_security_check_hp` does not appear in the Shanghai console even
  under “all scenarios” and returns no result when searched. Do not assume the
  published custom labels apply to HP; use `response_security_check_pro` for
  the first implementation unless Alibaba confirms HP inheritance later.

## References

- [Alibaba Cloud streaming moderation](https://help.aliyun.com/en/document_detail/2980054.html)
- [MultiModalGuard API](https://help.aliyun.com/en/document_detail/2937221.html)
- [Alibaba Cloud Node.js credentials](https://help.aliyun.com/en/sdk/developer-reference/v2-manage-node-js-access-credentials)
- [Alibaba Cloud multimodal SDK](https://help.aliyun.com/en/document_detail/2937220.html)
