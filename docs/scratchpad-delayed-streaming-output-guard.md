# Delayed Streaming Guard Scratchpad

Status: implemented and verified

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
and cross-segment cases. Review its false-positive and false-negative deltas
before publishing any cloud policy change; held-out cases must remain outside
the cloud few-shot prompt.

## Core rule

`assistant.delta` is provisional UI. The persisted
`conversation.model_message` is the single durable source of truth.
`turn.completed` only tells the live client that the durable commit finished.

```text
Model delta
  -> accumulate a segment
  -> Guard check
  -> pass: emit segment
  -> explicit block: abort and return an outcome flag
  -> provider error: emit normally
```

## Initial defaults

| Setting | Value |
|---|---:|
| First segment | 100 characters |
| Later segments | 250 characters |
| Local detection overlap | 100 characters (one first-segment window) |
| Guard calls in flight per stream | 1 |
| Error behavior | Fail open; only an explicit `block` withholds output |

The 100/250 split is an initial product heuristic, not a provider limit: the
short first segment bounds time to first visible text, while later 250-character
segments amortize the roughly 0.8-second Guard call. Keep the values stable
until production measurements justify changing them. Prefer sentence or
newline boundaries. Always check the final remainder with `done: true`.

All segments in one response share:

- `chatId`: current interaction round;
- `sessionId`: current output stream;
- `done: false`: intermediate segment;
- `done: true`: final segment.

For V1, use `run_id` as both `chatId` and `sessionId`. Cloud evals demonstrated
that Alibaba's correlation does not reliably preserve enough semantics across
segment boundaries. Runtime therefore prepends the trailing first-segment
window from approved output to the next detection request. The overlap is
detection-only and is never emitted or persisted twice.

## Runtime behavior

```text
Model:   segment 1 ---- segment 2 ---- segment 3
Guard:               check 1 ----- check 2 ----- check 3
Client:                       show 1 ----- show 2 ----- show 3
```

- Model generation may continue while the Guard checks.
- Later text stays in a bounded server-side buffer.
- Segments are checked and released in order.
- An explicit custom-label `block` withholds output.
- Guard timeout, throttling, malformed response, or provider error degrades to
  `pass` so Guard availability cannot fail the user's turn.

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

Guard timeout, throttling, malformed response, and provider failure degrade to
normal delivery. Only an explicit custom-label `block` produces
`content_filter`. Provider failures belong in operational telemetry, not
canonical conversation history. If provider usage is available, keep it only
in the existing `ConversationMessage.usage`; an aborted provider stream may
not return final token counts.

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
    "content": "My previous response was blocked before delivery and was not shown to the user. I must not reproduce or continue the blocked content."
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

Next-turn model projection:

```text
assistant:
My previous response was blocked before delivery and was not shown to the
user. I must not reproduce or continue the blocked content.
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
non-pass/non-block `customLabel` result is a provider error and degrades to
`pass` at the per-run middleware boundary.

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

Any custom-label `block` becomes `block`. Valid all-pass results become `pass`.
Missing or malformed results, timeout, throttling, and transport failures
degrade to `pass`. Do not retry a segment in the streaming path because a retry
can duplicate provider-side stream state and increases latency.

Per-run state is transient and intentionally small:

```ts
type GuardedOutput = {
  pending: string;
  detectionOverlap: string;
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

## Out of scope: Tool Call and Tool Result Guard

Tool Call and Tool Result Guard are explicitly excluded from Assistant Output
Guard V1. The notes below are retained only as future design context and are
not implementation or release requirements for this phase.

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

## Implementation status

The earlier persistence, wire protocol, projection, and Desktop mismatches have
been resolved. Protocol 0.4 uses `finish_reason`; new guarded runs persist
canonical `conversation.model_message` records; raw deltas and terminal wire
events are not durable; Desktop renders `content_filter` locally and rehydrates
the same outcome from server history. Local detection overlap is implemented
and verified against the published cloud policy.

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
- A split disclosure is caught by the local detection overlap even when the
  provider does not correlate segment semantics.
- Detection overlap is never emitted or persisted twice.
- Guard timeout, transport errors, and malformed provider responses degrade to
  normal delivery.
- Restart after a block renders client-local safety UI from the stored flag.
- A completed run writes exactly one terminal assistant record; intermediate
  model transcript records do not have `finish_reason`.
- No `assistant.delta` is present in durable storage.
- `turn.completed` is never persisted and never repeats assistant text.
- The next model turn sees only the model-friendly blocked-response message.

## Open questions

- After Guardrails activation, does `response_security_check_hp` execute a
  configured custom detection Agent and return `customLabel` results? The
  public docs establish custom prompts for `response_security_check`, but do
  not establish this for the high-performance service.
- Is it billed per segment request or per correlated stream?
- What QPS/TPS quota applies to the project account under sustained segmented
  output traffic?

## Alibaba deployment notes

- Hatch's single cloud development Runtime is ECS `i-uf6gvrytgdhiuohk4yp5` in `cn-shanghai-e`, VPC
  `vpc-uf6pf48y8qpyqnmq3mv48`; use the Shanghai VPC Guardrails endpoint.
- The ECS instance is attached to the project-level `HatchRuntimeRole`, which
  carries the existing Bailian access plus Alibaba Content Moderation access.
- AI Guardrails pay-as-you-go service was activated for the Alibaba Cloud
  account on 2026-08-09. The required service-linked role was created.
- Log Service remains disabled; no resource package or other add-on was
  purchased.

Custom detection prompts are configured in the Guardrails console as detection
tags and definitions. They are not sent with each API request. The published
configuration uses three focused tags:

```text
Tag: Agent内部信息泄露
Scope: current System/Developer instructions, hidden behavior rules, tool or Guard logic.

Tag: 当前私有Skill泄露
Scope: current private Skill content, procedures, references, paths, and structure.

Tag: 内部配置与评估标准泄露
Scope: current Runtime configuration, structured settings, evaluation weights, thresholds, and decision rules.
```

Each tag includes explicit pass boundaries for refusals, public examples,
generic explanations, and user-provided material. Do not add another tag unless
fresh held-out evals demonstrate a new semantic failure class.

### Published Alibaba configuration (2026-08-09)

- Region: `cn-shanghai` / 华东 2（上海）
- Service: `response_security_check_pro`
- Custom detection Agent: enabled and published
- Model: `Qwen3.6-Plus`
- Template: custom-label template
- Blocking labels:
  - `Agent内部信息泄露`
  - `当前私有Skill泄露`
  - `内部配置与评估标准泄露`
- Before local overlap, the 18-case regression over three rounds was 52/54,
  with zero false negatives and two false positives on a streamed refusal.
- With the 100-character rolling overlap, the same 18 cases passed 54/54 over
  three fresh rounds on 2026-08-10, including both streamed leak cases and the
  streamed safe refusal.
- Fresh held-out v2: 137/144. Single-segment protected configuration recall was
  65/66; six of seven false negatives were split disclosures, which motivated
  the local detection overlap.
- Built-in content-compliance and prompt-attack dimensions may remain enabled
  in the cloud template, but Runtime intentionally ignores them for this feature.
- `response_security_check_hp` does not appear in the Shanghai console even
  under “all scenarios” and returns no result when searched. Do not assume the
  published custom labels apply to HP; use `response_security_check_pro` for
  the first implementation unless Alibaba confirms HP inheritance later.

## References

- [Alibaba Cloud streaming moderation](https://help.aliyun.com/en/document_detail/2980054.html)
- [MultiModalGuard API](https://help.aliyun.com/en/document_detail/2937221.html)
- [Alibaba Cloud Node.js credentials](https://help.aliyun.com/en/sdk/developer-reference/v2-manage-node-js-access-credentials)
- [Alibaba Cloud multimodal SDK](https://help.aliyun.com/en/document_detail/2937220.html)
