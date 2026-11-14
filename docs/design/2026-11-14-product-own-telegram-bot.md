# Self-serve Telegram bot per Product

Status: shipped 2026-11-14 (PRs #349, #351, #352, #355, #360). Product chat only; the Studio Assistant's shared Hatch bot is unchanged.
Next: the same model for LINE, Discord, Slack and WhatsApp (not started; see "Adding another platform").

## Goal

An expert who only knows what Telegram is can give one of their Products its own Telegram bot, in their own bot's name, and hand it to anyone. People open the bot and chat; no sign-up, no purchase, no Hatch account.

## Product rules

- One expert, one bot per Product. A Product has at most one active bot at a time.
- A bot has two states only: **connected** or **removed**. No pause.
- Removing keeps everything (contacts, conversations, counts). Pasting the same bot's token back restores it and returning people continue their conversations.
- Connecting a different bot leaves the previous one dormant; switching back restores it.
- Within one account a dormant bot can move to another Product. Its contacts, counts and conversations move with it; from then on the new Product answers.
- A bot that is active on another Product must be removed there first. A bot owned by another account is always refused.
- Anyone can message the bot. Each person is a contact of that bot, isolated from every other bot: an expert never sees another bot's contacts or that the person exists elsewhere.
- In IM, `/new` starts a fresh conversation; the old one stays as history.
- The Publish card shows two numbers for the active bot: distinct users and inbound user messages, cumulative.
- If the Product is not published, the bot answers "这位专家暂时不可用 / This Expert is not available right now."

## Expert flow (Studio → Agent → Publish → Telegram card)

1. The card shows a six-step illustrated tutorial: open @BotFather → `/newbot` → name → username ending in `bot` (example `example_bot`) → copy the token → paste and connect. `/newbot` and the example have tap-to-copy; @BotFather is a tap-to-open link.
2. The token input trims spaces and checks the format (`^\d+:[A-Za-z0-9_-]{30,}$`) before sending.
3. Connected state: QR code (generated in the browser, downloadable PNG), `@username`, open bot, copy link, counts, replace bot (confirm), remove (confirm; says data is kept and reconnecting restores it).
4. Errors are plain-language (invalid token, bot in use elsewhere, service unavailable, network).

UI: `creator-dashboard/src/TelegramBotSetup.jsx`, `telegramBot.js`, `telegramBotCopy.js` (zh/en/ja).

## API

| Call | Does |
|---|---|
| `POST /v1/creator/connections/telegram/credentials` `{ product_id, token }` | Probe, provision, activate (see below). Returns the Product's channels view. |
| `DELETE /v1/creator/connections/telegram?product_id=` | Remove: the bot becomes dormant. |
| `GET /v1/creator/connections?product_id=` | Channels view; the telegram entry carries `configured`, `handle`, `users`, `messages`. |

Errors: `400 invalid_credentials`, `404 product_not_found`, `409 telegram_bot_active_elsewhere`, `409 telegram_bot_in_use`, `422 telegram_probe_failed`, `503 channel_unavailable`.

## Connecting a token (`channels/ownApps.ts`, `credentialForms.ts`)

1. Check the caller owns the Product.
2. Probe: Telegram `getMe` proves the token and returns the bot's id and username.
3. The bot's identity is its Telegram bot id. It is the Connection's `scope`, so one bot always maps to one Connection row.
4. Conflict check before touching the webhook: active on another Product → 409 active elsewhere; owned by another account → 409 in use.
5. If a Connection for this bot exists, reactivate it (dormant) or move it to this Product (same account); otherwise create it. Any other bot active on this Product becomes dormant and its webhook is released.
6. Provision: `setWebhook` to `/v1/channels/telegram/<scope>/webhook` with a random secret (checked on every update as `X-Telegram-Bot-Api-Secret-Token`), allowed updates `message`, `callback_query`, `my_chat_member`; `setMyCommands` registers `/new` (en default + zh).
7. The token is sealed (`CredentialSeal`) and stored on the Connection; it is never shown again.

Re-saving the active bot's token changes no data. Bots connected before bot-id scopes keep their old random scope and adopt the bot-id scope in place on their next save or removal.

Removing: `deleteWebhook`, clear the sealed credentials. The row, contacts, pointers and people stay.

## Data model

| Table | Role |
|---|---|
| `hatch_connections` | One row per bot: `owner_account_id`, `channel`, `scope` (bot id), `target` (`product:<id>`), `audience = public`, sealed `credentials` (null = dormant). Partial unique indexes: one active row per (owner, channel, audience, target) — `hatch_connections_active_idx`; one row per bot — `hatch_connections_bot_idx` (`channel, scope` where public). |
| `hatch_channel_identities` | A contact of one Connection (`sender_id` = Telegram user id, `thread_id` = chat id), plus `person_id`. |
| `hatch_channel_people` | The platform person behind contacts: `channel`, `platform_user_id`, name, username, language, `account_id` (null; for a later Telegram sign-in). Only for platforms whose sender id is global (Telegram, Discord). Never exposed to experts. |
| `hatch_contact_threads` | Current conversation per (connection, chat thread, principal). `/new` moves it. |
| `hatch_conversations` | Ordinary conversations. A contact's is owned by the principal key `contact:<connectionId>:<contactId>`; bound to the Product (moved with the bot). |
| `hatch_channel_inbox` | Inbound events, idempotent by `(channel, scope, event_id)`; source of the message count. |

Principal: the expert's own Studio entry is `self` and acts as the account; everyone writing to a public bot is `{ kind: "contact", connectionId, contactId }`.

## Conversation handling

- Inbound: webhook → verify secret → parse → inbox (idempotent) → ChatFlow → ProductTarget → contact binding → steer the active Run or start one.
- Binding: look up the thread pointer; none → create a conversation and pointer. Private chat: one long-lived conversation per person. Groups: one per person per group; the bot answers only when named or replied to.
- `/new` and `/new@BotName`: new conversation, pointer moves, short confirmation. A Run in flight finishes into the old conversation and its reply is still delivered (delivery is by Run, not by pointer).
- Rate limit per contact: burst 10, then one message per 20 s; over it the bot says it is busy.
- Replies: when a Run ends, the final reply is sent once through the outbox; a sweep on start catches unanswered Runs after a restart.
- A person who blocks the bot (`my_chat_member` kicked) loses only their own binding.
- Long conversations compact like web Product chat.

## Incidents and lessons

- **Schema drift (prod uuid vs code text).** Production `hatch_conversations` had five uuid columns from a retired UUID cutover (`uuidIdentityMigration.ts`) while the code DDL says text. Contact owner keys are not uuids, so no contact conversation could ever be stored in prod; CI never saw it because CI builds tables from the code DDL. It surfaced as "出了点问题，请再发一次" on the first real bot. Fixed in #360: idempotent ALTERs to text, the retired migration no longer touches those tables, and `schemaDrift.postgres.test.ts` seeds the old prod types and proves the migration. The same drift had already broken a backfill in #352 (fixed in #354).
- **Lesson for every new platform:** run one real message through production right after shipping, and keep the drift test pattern for any table whose prod history differs from its DDL.
- Known flaky tests (pre-existing, not fixed): `conversations/journal.test.ts` "a Run is recorded from its start" (timing on `idle()`), `chat/threadConversations.postgres.test.ts` "binding follows the pointer…" (race in `adoptThread` under concurrent binds).

## Adding another platform

Everything above the adapter is platform-neutral (Connections, contacts, pointers, `/new`, counts, dormant/restore, move). Per platform you add a per-product credential form (`credentialForms.ts`, `perProduct: true`) with `build`, `provision` (probe → stable bot id as scope, register the webhook, register commands if any) and `release`, plus a Publish card with its own tutorial.

| Platform | What the expert pastes | Bot id for scope | Webhook | Notes |
|---|---|---|---|---|
| LINE | Channel secret + channel access token | `GET /v2/bot/info` → bot `userId` (+ `basicId` for the link) | `PUT /v2/bot/channel/webhook/endpoint` | Setup is long (Official Account Manager, enable Messaging API, turn off auto-reply and greeting or LINE answers too). Reply messages are free and uncounted today but the reply token only lasts about a minute; slower answers fall back to push, which counts against a small monthly quota. LINE Thailand plans a 25,000/month cap on free replies from Feb 2027. User ids are per provider, so no cross-bot people. No command menu: `/new` is typed (or a quick-reply button). Adapter exists (`lineChannel.ts`). |
| Discord | Bot token + application id | application/bot id | Gateway, no webhook (probe only) | Per-product form already exists (`perProduct: true`). User ids are global → people work. Needs the bot invited to a server or DMs; slash command `/new` via application commands. |
| Slack | OAuth install (not a pasted token) | team + app/bot id | Events API URL from the app manifest | Installs per workspace; audience is a workspace, not "anyone". User ids are per workspace. |
| WhatsApp | WABA id + access token (Cloud API) | phone number id | App webhook in Meta | Needs a Meta business account and a phone number; 24-hour customer-service window, template messages outside it; per-conversation pricing. Sender id is a phone number per business — not linked as people. |

Before each: confirm what "anyone, no sign-in" means on that platform, the reply/cost limits, and whether the sender id is global (decides people linking). Verify one real message end to end in production after deploy.

## Open items

- No real-Telegram UAT before launch (no test bot token); first real use found the drift bug.
- Experts cannot yet read their contacts' conversations in Studio.
- `hatch_channel_people.account_id` is not wired to Telegram sign-in.
- The two flaky tests above.
