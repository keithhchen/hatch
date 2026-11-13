# Web edge cases: local real-stack run (not prod UAT)

| # | Scenario | Verdict | Findings |
|---|---|---|---|
| 1a | Reload the page mid-reply | PASS | none |
| 1b | Close the tab mid-reply and reopen the conversation | PASS | none |
| 2 | Network offline for 5 s mid-reply, then back online | PASS | none |
| 3a | Runtime restart mid-reply (deploy: SIGTERM, new process), then send again | PASS | none |
| 3c | Runtime outage: the only Runtime is down for 5 s mid-reply, then a new one starts | PASS | none |
| 3b | Runtime killed (kill -9) mid-reply, new process, then send again | PASS | none |
| 4a | Session revoked server-side mid-reply, then reload | PASS | none |
| 4b | Signed out in another tab mid-reply | PASS | none |
| 4c | Send after the session expired (idle page) | PASS | none |
| 5a | Two tabs on one conversation: B sends while A's reply streams | PASS | none |
| 5b | Two tabs on one conversation: both send at the same instant (idle) | PASS | none |
| 6a | Rapid double-send (double-click on Send; Enter twice) | PASS | none |
| 6b | Send while the WebSocket is still connecting (hello delayed 4 s) | PASS | none |
| 7 | Cancel mid-reply, then send again | PASS | none |
| 7b | Stop pressed just as the reply completes (the cancel frame reaches the Runtime after turn.completed) | PASS | none |
| 9a | A message over the Runtime's size limit (256K characters) | PASS | none |
| 9b | The session hello is refused by the Runtime (binding mismatch) | PASS | none |
| 8a | Fresh page load into a conversation whose run (started over the API) is in progress | PASS | none |
| 8b | Fresh browser (new context, same account) opens a conversation whose run another browser started | PASS | none |
| 10 | Double-click on Start conversation creates one conversation | PASS | none |
