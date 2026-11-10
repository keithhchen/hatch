# Surfaces v1: Studio and Chat from every client

Status: in progress (2026-11-10). Types: `runtime-server/src/surfaces/contract.ts`.

## The matrix

| | Studio API | Chat API |
|---|---|---|
| Coding agent (CLI, MCP) | manage the build by intent | talk to an Expert Product |
| IM | the Assistant in a linked chat | self-use, company-wide, customers |
| DM (Instagram, Messenger) | none | customers only |

Studio and Chat are two systems and stay two systems. These rules apply to both. The Studio Assistant is not a third: it is a conversation on Chat's runtime (see "The Assistant").

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

## Errors

- A failed Run reaches every client as one shape, `{code, message, reference}`, built once by the failure boundary (`runtime-server/src/errors`). Chat `turn.failed`, Studio `run_end`/status, the CLI and IM replies all carry it.
- A failure of something Hatch calls (the model provider, a third-party platform) is always `upstream_error`: "An upstream service Hatch uses failed. This is not a problem with your account. Reference: err_...". The provider's words, cause (quota, rate limit, configuration, transient), provider and status never leave the server.
- Hatch's own errors keep their code and real message (`run_failed`, `run_cancelled`, `run_interrupted`, refusals).
- Staff look a reference up in the server log line `{"event":"failure",...}` or `SELECT * FROM hatch_failures WHERE reference = ...` (Runtime with Postgres).

## Transports

HTTP and WebSocket, each streaming and non-streaming, observe the same Run and the same events.

| | Non-streaming | Streaming |
|---|---|---|
| HTTP | `POST messages?wait=N`: result, or `202` with `run_id` | `Accept: text/event-stream`, or `GET events?after_cursor=cursor` |
| WebSocket | subscribe with `stream: false` | subscribe with `stream: true` |

A slow consumer never slows a Run. It is disconnected and reconnects by cursor.

## Sign-in

Studio API and Chat API both accept browser auth and API keys. Browser WebSocket upgrades check Origin. API keys go in `Authorization` or the first message, never in a URL.

### Telegram as an identity provider

Telegram signs people in with OpenID Connect (the legacy widget and `login_url` hash flow is not used). It sits in the auth domain next to email sign-in (`src/auth`: `OidcClient`, `TelegramLogin`); the channel layer only asks for a link.

- One Telegram user id is one identity of at most one account (`account_identities`, primary key `(provider, subject)`). A Telegram-only account has no email and no password, and a password sign-in never matches it.
- Flow: Authorization Code with PKCE (S256), scopes `openid profile telegram:bot_access`, `state` and `nonce` stored server-side and spent once, ten minutes at most. The token endpoint is called with Basic client auth and the verifier. The `id_token` is accepted only as RS256, with the key picked by `kid` from `https://oauth.telegram.org/.well-known/jwks.json`, and only with the right `iss`, `aud` (the client id), `exp`, `iat` and `nonce`. The Telegram id is the `id` claim.
- The site routes are the dashboard's: `GET /v1/auth/telegram/start` (sets a `hatch_tg_state` cookie, redirects to Telegram) and `GET /v1/auth/telegram/callback` (the cookie must equal `state`; then the web session is set and the person is sent to the validated `returnTo`). The Registry holds the flow: `POST /v1/auth/telegram/start` and `POST /v1/auth/telegram/callback`. Sign-in and sign-up pages offer "Log in with Telegram" as a redirect, never a popup. Rate limits apply to start, callback and to links a chat may ask for.
- From the bot: a sender the shared bot does not know gets one URL button to `/v1/auth/telegram/start?claim=<code>`. The claim is issued for that sender id, expires in fifteen minutes and is used once. The callback is refused unless the token's `id` is that sender id, and the claim is spent either way. Then the account is found or made, the private chat is bound to its Studio Assistant Connection, and the Assistant's greeting is sent in Telegram. From the site, the same flow runs without a claim and binds no chat.
- An email account already signed in links Telegram from the Studio page with the link code deep link; redeeming it claims the Telegram id for that account, and refuses when the id belongs to another account.
- Deploy: in the @BotFather mini app, select the bot, Login Widget, and register the Allowed URLs `https://<site origin>` and `https://<site origin>/v1/auth/telegram/callback`. Copy the Client ID and Client Secret into `HATCH_TELEGRAM_LOGIN_CLIENT_ID` and `HATCH_TELEGRAM_LOGIN_CLIENT_SECRET`. The origin is `HATCH_TELEGRAM_PUBLIC_ORIGIN`, by default `https://$HATCH_DOMAIN_ALIAS`. Sign-in is off while either is empty.

## Tools

- Each API declares its full tool set once. The list and system prompt do not change within a conversation.
- A tool declares `supportedClients` from `web, desktop, cli, mcp, im, dm`, and its description says "Available on: ...".
- Each model call ends with a `<system-reminder>` of normalized client attributes: client, device, locale, language. It lists no tools and is never persisted or compacted.
- The harness authorizes every call against the client of the latest message. A call in progress when its provider disconnects enters `waiting_for_tool` and resumes when a permitted provider returns, until it times out.

## The Assistant

The Assistant is one conversation per account on Chat's runtime: the same Runs, steering, resume by cursor, compaction, idempotency and attachments (`ls`, `grep`, `read`) as a Product's conversation, with its own system prompt, the model `kimi-k2.6`, and the Studio tools.

- The Registry hosts it, because it holds the Products and tasks the tools operate. Its transcript, Runs and journal are in the Registry database; no other conversation lives there, and no part of the old factory-agent conversation runtime serves it.
- The Studio tools are declared once as `studio.*` (`supportedClients`: web, cli, mcp, im). A Product's conversation never declares them. Search, `ls`, `grep` and `read` are the same tools every conversation has.
- Studio's API for it (`/v1/creator/assistant/conversation/**`, the socket target `{assistant: true}`, the page's `/v1/creator/assistant`) is unchanged. Its event log is a projection of the Run's events in Studio's vocabulary; Chat's journal is the record.
- Work it starts (interview, content, research, build, evaluate) still runs on the factory-agent runtime as workers; their news reaches the Assistant as messages whose client message id starts with `sys:`, which the chat never shows as the Expert's.
- An interview holds the conversation by relay: the Expert's messages go to the interview, and its words come back as the Assistant's reply. News waits until it hands back.
- A reply to a Run the Assistant started on its own is owed to the Expert and is sent once, unless they are in Studio.
- The conversation it used to keep in its workspace is read once into Chat when the conversation is first opened.

## Channels

- Inbound: verify, store in a durable inbox, acknowledge, then process. Dedupe with a database constraint.
- `Connection` replaces `hatch_assistant_channels`, with no dual write. `ChannelAddress` separates thread from sender, and permission follows the sender.
- Outbound: a durable outbox. A failure that may have reached the platform is retried only with an idempotent send; otherwise it becomes `unknown`.
- Reply rendering degrades by `ChannelCapabilities`. A reply outside the platform's window stays in Hatch as `undelivered`. A message can carry one `link` (a URL button; a platform without buttons gets the URL in the text).
- Telegram has two roles. Our one shared bot (`HATCH_TELEGRAM_BOT_TOKEN`, `_USERNAME`, `_WEBHOOK_SECRET`; webhook `POST /v1/channels/telegram/webhook`, set by the Registry at every start) answers the Studio Assistant. A Product's chat is a bot of its own: an own-app Connection whose target is the Product and whose audience is `public`. Nothing is shared between them; the old start-code path for public Connections on the shared bot is gone.
- The Studio Assistant on the shared bot: the owner is the one identity bound by the link code or by the bot's sign-in; they act as the account. The owner can invite more people (`POST /v1/creator/connections/telegram/invites`, a single-use code valid seven days, sent as `t.me/<bot>?start=<code>`). The code admits no one by itself: the invitee is sent through the same Telegram sign-in, with the invite carried by the claim, and is admitted only when the token's id is the sender id. They are `guest` identities of the owner's Assistant Connection (role on the identity), contacts by `Principal`. The Assistant sees each of their messages marked `[<label>，专家授权的人，不是专家本人]`, so the prompt's rule about a speaker who is not the Expert applies; a guest cannot press task buttons, and never moves where the Assistant looks for the Expert (`expertSpoke`) or receives its pushes. The owner lists and revokes guests (`DELETE .../people/<id>`). An owner cannot also be a guest. Anyone else who writes to the shared bot in a private chat gets the sign-in button; in a group, silence.
- A Product's bot (`POST /v1/creator/connections/telegram/credentials` with `product_id`, the owner's own Product only): saving a token calls `getMe` (a bad token is a 422 with Telegram's message and nothing is saved), then `setWebhook` to `<public origin>/v1/channels/telegram/<scope>/webhook` with a generated `secret_token`, sealed with the token. The scope is a fresh id for each bot, so the webhook path, the inbox, the identities and the outbox all name the bot; contacts of one bot are not contacts of another. Saving a different token replaces the bot, calls `deleteWebhook` on the old one and drops its contacts; the same token again keeps the webhook. `DELETE ...?product_id=` calls `deleteWebhook`, drops the credentials and revokes the Connection. Anyone who writes to the bot is met as a contact with no sign-up (limits and the live-Product check still run before a Run).
- A `self` Connection that targets a Product on another platform serves the account that linked it, as that account: its conversation is the account's own, and the Product must be its own.
- `public` conversations have a contact `Principal`, with limits checked before a Run. Contacts are isolated by connection and contact. `public` never declares Studio tools. Billing for contacts is out of scope for v1.

## Attachments

Upload first, reference by `assetId`, and send a message only when its assets are ready. An asset joins its message in the transaction that accepts the message, so a crash leaves it free. An upload still `processing` after its lease was abandoned by a crash: uploading the same bytes again retries it.

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

Compaction is visible: a `compacting` status, and a completed marker. Every compaction has a durable id (`compaction.started`, then exactly one of `compaction.completed` or `compaction.aborted`, in the journal), which the channel layer uses for one notice per compaction, only when a user is waiting. The notice is not part of the conversation.

## Out of scope

YouTube has no DM API. WeChat ClawBot has no confirmed third-party license.

## Evidence levels

Record unit or component tests, integration tests and real-account product acceptance separately. A channel without a real account or platform approval is "not accepted", whatever its tests say.
