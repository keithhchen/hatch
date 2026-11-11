# Acceptance: Studio Assistant on web and Telegram

Every merge into `chat-studio-surfaces` is checked against this list on a real local stack (`node scripts/try-telegram/run.mjs`, real models). Production deploys are checked again on gethatchapp.com with a real Telegram account. A row passes only on the real product path. Unit tests and fake platforms are recorded separately and never count as a pass here.

## Web Assistant

1. Sign up, open the Assistant, send a message: one bubble, one reply, in order.
2. Send three messages fast while a reply is streaming: three bubbles in order, none lost, none duplicated. The reply takes all three into account.
3. Refresh during a streaming reply: history is complete, and the reply resumes or lands once, with no second copy.
4. Refresh right after sending: the message is still there.
5. Send text and a file in one message: one bubble with the text and a file chip, never a raw `[file: …]` line.
6. Send the same file twice in two messages: both accepted.
7. Send an image: the reply shows the model saw it.
8. Dictate with the mic: the transcript lands in the box and is sent only when the user presses send.
9. A reply that calls tools shows its steps once, in order with the text. Thinking shows as one collapsible item.
10. While a reply streams, the page follows the bottom. If the user scrolled up, it stays where they are.
11. An upstream failure shows a plain message with a reference code.
12. Ask it to extract or summarise an uploaded file: it does so straight away.

## Telegram ↔ Studio

13. A stranger presses Start on the shared bot, signs in with Telegram, and comes back to a greeting. No email or password.
14. The same person on the web uses "Log in with Telegram" and sees the same Assistant and history.
15. Text, photo, file and voice in Telegram all reach the Assistant. Voice arrives as text.
16. Several quick messages in Telegram give one reply each time the Assistant answers, sent to the right chat.
17. Invite a second Telegram account. It can talk to the owner's Assistant, is marked as not the owner, and loses access once revoked.

## Products

18. A Product's own bot: save the token, and anyone can chat with it without signing up.
19. After publishing, which is unlisted by default, the Assistant gives the full product page and chat page links.

## Integrity, checked in the database after the rows above

20. One stored message per user action: no duplicate `client_message_id`, and no message accepted but missing from history.
21. Every Run ends in a terminal state, with a terminal event.
