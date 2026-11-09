# Surfaces v1: Studio and Chat from every client

Status: in progress (2026-11-10). Types: `runtime-server/src/surfaces/contract.ts`.

## The matrix

| | Studio API | Chat API |
|---|---|---|
| Coding agent (CLI, MCP) | manage the build by intent | talk to an Expert Product |
| IM | the Assistant in a linked chat | self-use, company-wide, customers |
| DM (Instagram, Messenger) | none | customers only |

Studio and Chat are two systems and stay two systems. These rules apply to both.

## Runs

- The server owns a Run. Closing a client never stops it. Only an explicit stop does.
- Any client resumes: `snapshot` (history, state, partial output, cursor), then events after that cursor.
- A message that arrives during a Run steers it, whichever client sent it. There is no merge window. The steer-or-start decision is atomic.
- While compacting, messages wait and join afterwards.
- Idempotency is per message: a client key plus a digest of content and ordered asset hashes. A channel message uses its event id as the key.
- A channel gets one final reply, sent when the Run ends.
- Claiming a steered message and appending it to the transcript is one transaction.
- A call to a local tool is recorded before the client is asked. The Run stays `waiting_for_tool` across a Runtime restart; any permitted client, on any instance, answers it once, and the call times out at its recorded expiry.
- A Run taken over after a crash continues from its transcript. A call that finished is never run again. A read-only call that did not finish is reported to the model as not run; any other server call that did not finish may have had an effect, so the Run is interrupted instead of repeating it.
- Live deltas reach observers on every instance through a bounded relay that never waits for a consumer or the database.

## Transports

HTTP and WebSocket, each streaming and non-streaming, observe the same Run and the same events.

| | Non-streaming | Streaming |
|---|---|---|
| HTTP | `POST messages?wait=N`: result, or `202` with `run_id` | `Accept: text/event-stream`, or `GET events?after=cursor` |
| WebSocket | subscribe with `stream: false` | subscribe with `stream: true` |

A slow consumer never slows a Run. It is disconnected and reconnects by cursor.

## Sign-in

Studio API and Chat API both accept browser auth and API keys. Browser WebSocket upgrades check Origin. API keys go in `Authorization` or the first message, never in a URL.

## Tools

- Each API declares its full tool set once. The list and system prompt do not change within a conversation.
- A tool declares `supportedClients` from `web, desktop, cli, mcp, im, dm`, and its description says "Available on: ...".
- Each model call ends with a `<system-reminder>` of normalized client attributes: client, device, locale, language. It lists no tools and is never persisted or compacted.
- The harness authorizes every call against the client of the latest message. A call in progress when its provider disconnects enters `waiting_for_tool` and resumes when a permitted provider returns, until it times out.

## Channels

- Inbound: verify, store in a durable inbox, acknowledge, then process. Dedupe with a database constraint.
- `Connection` replaces `hatch_assistant_channels`, with no dual write. `ChannelAddress` separates thread from sender, and permission follows the sender.
- Outbound: a durable outbox. A failure that may have reached the platform is retried only with an idempotent send; otherwise it becomes `unknown`.
- Reply rendering degrades by `ChannelCapabilities`. A reply outside the platform's window stays in Hatch as `undelivered`.
- `public` conversations have a contact `Principal`, with limits checked before a Run. Contacts are isolated by connection and contact. `public` never declares Studio tools. Billing for contacts is out of scope for v1.

## Attachments

Upload first, reference by `assetId`, and send a message only when its assets are ready.

| | Image | File | Voice message |
|---|---|---|---|
| Model sees | pixels, with a path label | one line: name, type, size | transcript as the message |
| Stored | original and resized | original and extracted text | original |
| Later | dropped oldest-first by byte budget, replaced by the path label | stays reachable by path | text |

Retrieval is Unix style in both APIs: `ls`, `grep` and paged `read`, with no vector index. Studio keeps its POSIX workspace and adds `grep`. Chat has virtual files over object storage and no sandbox. A customer's file never enters a creator's Corpus.

## Compaction

One strategy for Chat and Studio (`compactionStrategy.ts`), each with its own adapter. Its limits derive from the model's context window.

- Order: prune old tool results, only once the provider's cache has expired (a live cache keeps its prefix), then summarize.
- Timing: after the reply, in the background; a new message aborts it, on any instance, and waits for it to end. Falls back to before a turn, between tool steps, and recovery after a provider overflow, at most twice per Run.
- Content: a verbatim tail that never splits a tool call from its results; a structured summary; unfinished requests, file paths read and written, senders and identifiers are checked after summarizing, retried once, then appended as written.
- Failure or timeout: a bounded verbatim tail and a note of how many messages were dropped; the user is told only then. A manual compaction that fails raises.
- Durable memory is written first where a conversation type has a memory layer. Chat and Studio have none.
- Reminders are never compacted. Images are path labels.

Compaction is visible: a `compacting` status, and a completed marker. Every compaction has a durable id (`compaction.started`, `compaction.completed` in the journal), which the channel layer uses for one notice per compaction, only when a user is waiting. The notice is not part of the conversation.

## Out of scope

YouTube has no DM API. WeChat ClawBot has no confirmed third-party license.

## Evidence levels

Record unit or component tests, integration tests and real-account product acceptance separately. A channel without a real account or platform approval is "not accepted", whatever its tests say.
