# Runtime Review: desktop-chat-5

Date: 2026-07-18  
Scope: server-side skill, local file context, real LLM run, chat history/tool history reload

## Verdict

`desktop-chat-5` partially meets the current product expectations.

The main path works: a real cloud LLM run used a server-side skill, requested local tools, eventually read a local contract file, and produced a useful legal review. It is not yet a full pass because workspace resolution, local tool policy, tool history persistence, and skill invocation metadata still have product/runtime gaps.

## What Passed

- Real LLM route is active through the runtime server configuration.
- Server-side skill loading works for `review-contract`.
- The local client can execute `fs.read` and return file content into the server-owned agent loop.
- The final assistant answer substantially satisfied the legal review task:
  - prioritized risk list
  - redline direction
  - fallback positions
  - negotiation strategy
  - lawyer review disclaimer
- Conversation reload shows the final assistant message plus part of the tool chain.
- The `direct_read_required` guard fired for `file_search`.

## Gaps

### 1. Workspace Root Mismatch

The user asked the agent to read:

```text
legal-samples/acme-analytics-saas-agreement.md
```

The client workspace for this run was:

```text
/Users/keithchen/Documents
```

The target file actually lived under the Hatch repo:

```text
/Users/keithchen/Documents/Codex/2026-05-14/content-is-user-generated-and-unverified/hatch/legal-samples/acme-analytics-saas-agreement.md
```

Result: the first exact `fs.read` failed, and the agent recovered by searching/listing more broadly.

Expected product behavior:

- The chat UI should make the active workspace root obvious.
- The user should be able to select/switch the workspace root.
- If an exact relative path cannot be read in the active workspace, the agent should report workspace mismatch instead of guessing silently.

### 2. Direct-Read Policy Is Incomplete

The runtime blocked `file_search` with `direct_read_required`, but the model then used:

```text
fs.list "."
shell.exec find /Users/keithchen/Documents ...
```

This violates the intended behavior for exact path tasks:

```text
If the user gives an exact local path, read that path first.
If it fails, report workspace mismatch.
Do not broaden to workspace-wide or absolute-root search unless the user explicitly asks to locate the file.
```

The policy needs to apply consistently to `file_search`, `fs.list`, and shell commands that perform broad file discovery.

### 3. Reloaded Tool History Is Incomplete

The raw event log contains a `file_search_2` result with `direct_read_required`, but the visible conversation API does not include it.

Observed cause:

- `runtime-server/src/index.ts` persists `tool_call.delta` only when `event.locality === "server"`.
- Client/local runtime guard results are therefore not written as visible `tool.call` records.
- `runtime-server/src/store.ts` reconstructs visible tool calls only from persisted `tool.call` records.

Expected behavior:

- Reloaded chat history should show the full tool chain.
- Runtime guard results should be visible because they are part of the agent's reasoning/action path.

### 4. Skill Invocation Metadata Is Misleading

The visible conversation reports:

```text
skill.activated review-contract reason: explicit_mention
```

But this run did not use an explicit `$review-contract` user invocation. The skill was selected/loaded by the runtime/model path.

Expected behavior:

- Preserve the true activation reason and source.
- Do not hardcode `explicit_mention` in visible history reconstruction.
- The UI should distinguish:
  - skill available in session
  - skill selected by model
  - skill document read
  - skill invoked for the answer

### 5. Shell Timeout Is Treated Too Much Like Success

One `shell.exec` call timed out but still returned useful stdout. The run continued using that output.

Expected behavior:

- Mark this state as partial/timeout/degraded, not normal success.
- Preserve stdout, stderr, timeout flag, and exit code distinctly in the visible tool result.

### 6. Markdown/UI Stress Case Still Needs Visual Verification

The final answer is long and contains dense legal analysis. It is a useful regression case for:

- long Markdown response rendering
- numbered and bulleted list layout
- table/code overflow
- chat width containment
- tool-call expansion layout

## Priority Fix Order

1. Make active workspace root explicit and switchable in the desktop chat UI.
2. Enforce exact-path/direct-read policy across all local discovery tools, not just `file_search`.
3. Persist all terminal tool-call events needed to reconstruct visible chat history after reload.
4. Preserve accurate skill activation/invocation metadata.
5. Represent timeout/partial shell results distinctly in both protocol and UI.
6. Use `desktop-chat-5` as a visual regression fixture for Markdown and tool-call rendering.

## Product Bar

This is not primarily a model-quality issue. The model completed the legal task. The remaining problems are runtime contract and product consistency issues:

```text
workspace selection
tool policy enforcement
history persistence
skill invocation observability
tool result state modeling
chat rendering robustness
```
