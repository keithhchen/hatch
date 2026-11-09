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

Runs after the reply in the background and yields to a new message. Falls back to before or during a turn, then to recovery after a provider overflow. Durable memory is written first. Old tool results are pruned separately, when the cache has expired.

Compaction is visible: a status in the UI, and on IM one notice per compaction, only when a user is waiting. The notice is not part of the conversation.

## Out of scope

YouTube has no DM API. WeChat ClawBot has no confirmed third-party license.

## Evidence levels

Record unit or component tests, integration tests and real-account product acceptance separately. A channel without a real account or platform approval is "not accepted", whatever its tests say.
