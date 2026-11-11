# Studio Assistant web: acceptance on a real local stack, 2026-11-11

Checklist: `docs/acceptance-studio-telegram.md`. Code: `chat-studio-surfaces` at `53c8f761`.

**Level: real integration on a local stack.** This used real Postgres, Registry, Runtime and Dashboard processes behind Caddy, the real Gemini 3.1 Pro, and a real browser. It ran on localhost (`scripts/try-telegram/run.mjs`, `NO_NGROK=1`), not on gethatchapp.com, and no Telegram was involved. The account was a throwaway local test account.

| # | Result | What was seen |
|---|---|---|
| 1 | Pass | Sign up, open the Assistant, send: one bubble, one reply. |
| 2 | Pass | Three messages sent while a reply streamed. The bubbles stayed in order, and the two that joined showed as queued, then normal. The reply took all three into account. |
| 3 | Pass | Refresh mid-reply: history was complete and the reply landed once. |
| 4 | Pass | Refresh one second after sending: the message was still there. |
| 5 | Pass | Text plus a file arrived as one bubble with a file chip. No raw `[file: …]` line. |
| 6 | Pass | The same file sent again in a later message was accepted. |
| 7 | Pass | Image: the reply read the sign text correctly ("MOSS COFFEE", "2018"). The image renders in the bubble. |
| 8 | Pass (production, user) | Dictation checked by the user on gethatchapp.com after the ffmpeg fix (#227). |
| 9 | Pass | Steps showed once and in order: thinking, tool, thinking. Thinking is one collapsible item. |
| 10 | Pass | While streaming, the page stayed at the bottom (distance 0 over 18 s). After scrolling up, the position held (scrollTop 100 over 18 s). The scroll-up was set by script, not a real wheel. |
| 11 | Pass (earlier run) | An upstream failure showed a plain message with a reference code. The Retry button that appears after a refresh is covered by unit tests only. |
| 12 | Pass | "Summarise my checklist" was answered from the file straight away. |
| 13–19 | Pass (production, user) | Telegram checked by the user on gethatchapp.com with a real Telegram account. Not recorded item by item. |
| 20 | Pass | No duplicate `client_message_id`. 7 messages accepted, 7 visible in history, message ids unique. |
| 21 | Pass | Every Run is terminal with a matching `run.state` journal event. The journal cursor has no gaps. |

## Found and sent for a fix

- After several Runs started by the system (`sys:` messages from the interview), the page kept a "typing… Connected" row although nothing was running. A refresh cleared it. **Fixed** (merges of 724483fe and 88ec4630): a refresh that adopted the real id of a Run the page had started wrote back its rows under the provisional id, which left an orphan live row. Rechecked on the same stack with two more interview answers, each followed by fast handover and system Runs: no typing row remained, and the server reported `running: false`.
- The interview repeated the same opening line ("我们还剩三件事…") after each system Run. This is Assistant behaviour, not a data fault. It is noted here and not yet changed.

## Production follow-up (2026-11-11, evening)

**Level: real product UAT on gethatchapp.com, by the user with their own accounts.** The user reported that dictation (item 8) and Telegram (items 13–19) work in production. Discord replies were fixed (#231) and checked by the user in a real DM.
