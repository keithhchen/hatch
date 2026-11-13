import { Client, SHORT, STORY, norm } from "./browser.mjs";
import { sleep } from "../verify-surfaces/lib/util.mjs";

/**
 * Each scenario drives the real web chat page in a real browser, against the real Dashboard, Registry, Runtime and Postgres, during a
 * streaming reply unless noted. It returns { clients, conversationId, expected?, extra? }; run.mjs then audits everything the browsers
 * and servers recorded and compares the final UI to the Runtime's own history. `expected` patterns are the only things allowed to
 * appear, and each carries the reason it is warranted.
 */
const streaming = (c) => c.watch.waitFrame("assistant.delta");
const finishOk = async (ctx, c, { page = c.page } = {}) => { const quiet = await c.settle({ page, api: ctx.world.forConversation(c.conversationId) }); return quiet; };

export const scenarios = [
  {
    id: "1a", title: "Reload the page mid-reply",
    async run(ctx) {
      const c = await ctx.open();
      await c.send(STORY); await streaming(c);
      await c.page.reload();
      await c.ready();
      const quiet = await finishOk(ctx, c);
      return { clients: [c], conversationId: c.conversationId, extra: quiet ? [] : [{ kind: "no-settle", detail: "UI never became idle after reload" }] };
    }
  },
  {
    id: "1b", title: "Close the tab mid-reply and reopen the conversation",
    async run(ctx) {
      const c = await ctx.open();
      await c.send(STORY); await streaming(c);
      await c.page.close(); await sleep(1500);
      c.page = await c.newPage();
      await c.goto(c.conversationId);
      const quiet = await finishOk(ctx, c);
      return { clients: [c], conversationId: c.conversationId, extra: quiet ? [] : [{ kind: "no-settle", detail: "UI never became idle after reopen" }] };
    }
  },
  {
    id: "2", title: "Network offline for 5 s mid-reply, then back online",
    async run(ctx) {
      const c = await ctx.open();
      await c.send(STORY); await streaming(c);
      await c.context.setOffline(true); await sleep(5000);
      ctx.note(`while offline the UI showed: ${JSON.stringify(await c.visibleAlerts())}`);
      await c.context.setOffline(false);
      const quiet = await finishOk(ctx, c);
      return { clients: [c], conversationId: c.conversationId, extra: quiet ? [] : [{ kind: "no-settle", detail: "UI never became idle after the network returned" }] };
    }
  },
  {
    id: "3a", title: "Runtime restart mid-reply (deploy: SIGTERM, new process), then send again",
    async run(ctx) {
      const c = await ctx.open();
      await c.send(STORY); await streaming(c);
      await ctx.restartRuntime({ kill: false });
      let quiet = await finishOk(ctx, c);
      ctx.note(`after restart the UI shows ${JSON.stringify((await c.messages()).map((m) => [m.role, m.state, m.text.slice(0, 40)]))}; alerts now: ${JSON.stringify(await c.visibleAlerts())}`);
      await c.send(SHORT("pong")); await c.watch.waitFrame("turn.completed", { since: 0, timeout: 120_000 }).catch(() => undefined);
      quiet = (await finishOk(ctx, c)) && quiet;
      return { clients: [c], conversationId: c.conversationId, extra: quiet ? [] : [{ kind: "no-settle", detail: "UI never became idle" }] };
    }
  },
  {
    id: "3c", title: "Runtime outage: the only Runtime is down for 5 s mid-reply, then a new one starts",
    async run(ctx) {
      const c = await ctx.open();
      await c.send(STORY); await streaming(c);
      await ctx.restartRuntime({ kill: false, outage: 5000 });
      let quiet = await finishOk(ctx, c);
      const stale = await c.visibleAlerts();
      ctx.note(`after the outage the UI shows ${JSON.stringify((await c.messages()).map((m) => [m.role, m.state, m.text.slice(0, 40)]))}; alerts now: ${JSON.stringify(stale)}`);
      await c.send(SHORT("pong"));
      quiet = (await finishOk(ctx, c)) && quiet;
      // While no Runtime exists the Dashboard answers 502 and the page says Hatch is temporarily unavailable: warranted, but only until the Runtime is back (checked by the notes and the final UI).
      return { clients: [c], conversationId: c.conversationId, expected: { alerts: [/temporarily unavailable/], http: [/502 /], logs: [/"status":502/] }, extra: [...(quiet ? [] : [{ kind: "no-settle", detail: "UI never became idle" }]), ...(stale.length ? [{ kind: "stale-alert", detail: `the outage's error is still shown after the Runtime came back: ${JSON.stringify(stale)}` }] : [])] };
    }
  },
  {
    id: "3b", title: "Runtime killed (kill -9) mid-reply, new process, then send again",
    async run(ctx) {
      const c = await ctx.open();
      await c.send(STORY); await streaming(c);
      await ctx.restartRuntime({ kill: true });
      let quiet = await finishOk(ctx, c);
      ctx.note(`after kill the UI shows ${JSON.stringify((await c.messages()).map((m) => [m.role, m.state, m.text.slice(0, 40)]))}; alerts now: ${JSON.stringify(await c.visibleAlerts())}`);
      await c.send(SHORT("pong"));
      quiet = (await finishOk(ctx, c)) && quiet;
      // The Run really died with its process: telling the user so, and that they can send again, is the warranted outcome.
      return { clients: [c], conversationId: c.conversationId, expected: { alerts: [/Runtime restarted while this Run was in progress/], frames: [/turn\.failed/] }, extra: quiet ? [] : [{ kind: "no-settle", detail: "UI never became idle" }] };
    }
  },
  {
    id: "4a", title: "Session revoked server-side mid-reply, then reload",
    async run(ctx) {
      const c = await ctx.open();
      await c.send(STORY); await streaming(c);
      await ctx.expireWebSessions();
      ctx.note(`UI settled within 25 s of the expiry: ${await c.settle({ timeout: 25_000 })}`);
      ctx.note(`after expiry mid-reply the UI shows ${JSON.stringify((await c.messages()).map((m) => [m.role, m.state, m.text.slice(0, 40)]))}; alerts now: ${JSON.stringify(await c.visibleAlerts())}`);
      await c.shot(ctx.shot("4a-after-expiry"));
      await c.page.reload(); await sleep(2500);
      ctx.note(`after reload without a session: ${JSON.stringify(await c.bodyText())}`);
      await c.shot(ctx.shot("4a-after-reload"));
      // The page is a sign-in gate now, so there is no conversation to compare: the server-side record is checked on its own.
      // The session is gone, so the Dashboard (and the Registry behind it) answering 401 is the correct answer; the page must then go to sign-in.
      return { clients: [c], conversationId: c.conversationId, skipUi: true, expected: { http: [/401 /], logs: [/"status":401/] } };
    }
  },
  {
    id: "4b", title: "Signed out in another tab mid-reply",
    async run(ctx) {
      const c = await ctx.open();
      await c.send(STORY); await streaming(c);
      const other = await c.newPage();
      await other.goto(`${ctx.web.url}/`);
      const status = await other.evaluate(async () => {
        const csrf = decodeURIComponent((document.cookie.match(/hatch_web_csrf=([^;]+)/) ?? [])[1] ?? "");
        return (await fetch("/v1/auth/logout", { method: "POST", headers: { "x-csrf-token": csrf } })).status;
      });
      ctx.note(`sign-out in the other tab -> ${status}`);
      await other.close();
      ctx.note(`UI settled within 25 s of the sign-out: ${await c.settle({ timeout: 25_000 })}`);
      ctx.note(`UI after the other tab signed out: ${JSON.stringify((await c.messages()).map((m) => [m.role, m.state, m.text.slice(0, 40)]))}; alerts now: ${JSON.stringify(await c.visibleAlerts())}`);
      await c.shot(ctx.shot("4b-after-signout"));
      // The logout fetch is the harness's own, from a tab it closes right after.
      return { clients: [c], conversationId: c.conversationId, skipUi: true, expected: { failed: [/POST \/v1\/auth\/logout/], http: [/401 /], logs: [/"status":401/] } };
    }
  },
  {
    id: "4c", title: "Send after the session expired (idle page)",
    async run(ctx) {
      const c = await ctx.open();
      await c.send(SHORT("one")); await c.watch.waitFrame("turn.completed", { timeout: 90_000 }); await finishOk(ctx, c);
      await ctx.expireWebSessions();
      await c.send(SHORT("two")); await sleep(6000);
      ctx.note(`UI after sending with an expired session: ${JSON.stringify((await c.messages()).map((m) => [m.role, m.state, m.text.slice(0, 40)]))}; alerts: ${JSON.stringify(await c.visibleAlerts())}; body: ${JSON.stringify(await c.bodyText())}`);
      await c.shot(ctx.shot("4c-after-send"));
      // The Runtime refuses the message because the session is gone and says so in plain words; the page then goes to sign-in.
      return { clients: [c], conversationId: c.conversationId, skipUi: true, expected: { alerts: [/session is no longer valid/], frames: [/turn\.failed/], http: [/401 /], logs: [/"status":401/] } };
    }
  },
  {
    id: "5a", title: "Two tabs on one conversation: B sends while A's reply streams",
    async run(ctx) {
      const a = await ctx.open({ label: "A" });
      const b = await ctx.open({ label: "B", conversationId: a.conversationId, reuse: a });
      await a.send(STORY); await streaming(a);
      await b.send(SHORT("bravo"), b.page);
      const quietA = await finishOk(ctx, a); const quietB = await finishOk(ctx, b);
      const same = JSON.stringify((await a.messages()).map((m) => [m.role, norm(m.text)])) === JSON.stringify((await b.messages()).map((m) => [m.role, norm(m.text)]));
      return { clients: [a, b], conversationId: a.conversationId, extra: [...(quietA && quietB ? [] : [{ kind: "no-settle", detail: "a tab never became idle" }]), ...(same ? [] : [{ kind: "tabs-diverge", detail: "tab A and tab B show different conversations" }])] };
    }
  },
  {
    id: "5b", title: "Two tabs on one conversation: both send at the same instant (idle)",
    async run(ctx) {
      const a = await ctx.open({ label: "A" });
      const b = await ctx.open({ label: "B", conversationId: a.conversationId, reuse: a });
      await Promise.all([a.send(SHORT("alpha")), b.send(SHORT("bravo"))]);
      await sleep(3000);
      const quietA = await finishOk(ctx, a); const quietB = await finishOk(ctx, b);
      await sleep(1500); // let B pick up whatever A's send produced
      const same = JSON.stringify((await a.messages()).map((m) => [m.role, norm(m.text)])) === JSON.stringify((await b.messages()).map((m) => [m.role, norm(m.text)]));
      return { clients: [a, b], conversationId: a.conversationId, extra: [...(quietA && quietB ? [] : [{ kind: "no-settle", detail: "a tab never became idle" }]), ...(same ? [] : [{ kind: "tabs-diverge", detail: "tab A and tab B show different conversations" }])] };
    }
  },
  {
    id: "6a", title: "Rapid double-send (double-click on Send; Enter twice)",
    async run(ctx) {
      const c = await ctx.open();
      await c.composer().fill(SHORT("dbl")); await c.page.locator(".web-chat__send").dblclick();
      await sleep(500);
      await c.composer().fill(SHORT("enter")); await c.composer().press("Enter"); await c.composer().press("Enter");
      await sleep(1000);
      const quiet = await finishOk(ctx, c);
      const users = (await ctx.world.messages(c.conversationId)).filter((m) => m.role === "user").map((m) => m.text);
      const extra = [];
      for (const word of ["dbl", "enter"]) { const n = users.filter((t) => t.endsWith(word)).length; if (n !== 1) extra.push({ kind: "double-send", detail: `"${word}" reached the Runtime ${n} times` }); }
      return { clients: [c], conversationId: c.conversationId, extra: [...extra, ...(quiet ? [] : [{ kind: "no-settle", detail: "UI never became idle" }])] };
    }
  },
  {
    id: "6b", title: "Send while the WebSocket is still connecting (hello delayed 4 s)",
    async run(ctx) {
      const first = await ctx.open();
      const conversationId = first.conversationId; await first.close();
      const c = await ctx.open({ conversationId, beforeGoto: async (page) => {
        await page.routeWebSocket(/\/v1\/web-chat\/runtime/, (ws) => {
          const server = ws.connectToServer();
          const ready = sleep(4000);
          ws.onMessage(async (m) => { await ready; server.send(m); });
          server.onMessage((m) => ws.send(m));
          ws.onClose((code, reason) => server.close({ code, reason })); server.onClose((code, reason) => ws.close({ code, reason }));
        });
      } });
      // The composer is usable before the socket is: type and send at once.
      await c.send(STORY);
      const quiet = await finishOk(ctx, c);
      return { clients: [c], conversationId, extra: quiet ? [] : [{ kind: "no-settle", detail: "UI never became idle" }] };
    }
  },
  {
    id: "7", title: "Cancel mid-reply, then send again",
    async run(ctx) {
      const c = await ctx.open();
      await c.send(STORY); await streaming(c);
      await c.page.locator(".web-chat__stop").click();
      let quiet = await finishOk(ctx, c);
      ctx.note(`after Stop the UI shows ${JSON.stringify((await c.messages()).map((m) => [m.role, m.state, m.text.slice(0, 40)]))}`);
      await c.send(SHORT("pong"));
      quiet = (await finishOk(ctx, c)) && quiet;
      // A stopped Run ends on the wire as turn.failed with run_cancelled; the page must show it as a cancellation, not an error.
      return { clients: [c], conversationId: c.conversationId, expected: { frames: [/turn\.failed run_cancelled/] }, extra: quiet ? [] : [{ kind: "no-settle", detail: "UI never became idle" }] };
    }
  },
  {
    id: "7b", title: "Stop pressed just as the reply completes (the cancel frame reaches the Runtime after turn.completed)",
    async run(ctx) {
      const first = await ctx.open(); const conversationId = first.conversationId; await first.close();
      const c = await ctx.open({ conversationId, beforeGoto: async (page) => {
        let completed; const done = new Promise((resolve) => { completed = resolve; });
        await page.routeWebSocket(/\/v1\/web-chat\/runtime/, (ws) => {
          const server = ws.connectToServer();
          ws.onMessage(async (m) => { if (String(m).includes('"turn.cancel"')) await done; server.send(m); });
          server.onMessage((m) => { ws.send(m); if (String(m).includes('"turn.completed"')) completed(); });
          ws.onClose((code, reason) => server.close({ code, reason })); server.onClose((code, reason) => ws.close({ code, reason }));
        });
      } });
      await sleep(1500);
      await c.send(SHORT("done"));
      await c.page.locator(".web-chat__stop").click();
      await c.page.locator(".web-chat__stop").waitFor({ state: "detached", timeout: 120_000 });
      await sleep(2000);
      const quiet = await finishOk(ctx, c);
      return { clients: [c], conversationId, extra: quiet ? [] : [{ kind: "no-settle", detail: "UI never became idle" }] };
    }
  },
  {
    id: "9a", title: "A message over the Runtime's size limit (256K characters)",
    async run(ctx) {
      const c = await ctx.open();
      await c.composer().fill("x".repeat(262_145));
      await c.page.locator(".web-chat__send").click();
      await sleep(5000);
      const alerts = await c.visibleAlerts();
      ctx.note(`UI after the oversize send: alerts ${JSON.stringify(alerts)}; messages ${JSON.stringify((await c.messages()).map((m) => [m.role, m.state, m.text.slice(0, 20)]))}; draft length ${(await c.composer().inputValue()).length}; busy ${await c.busy()}`);
      const extra = [];
      if (alerts.some((a) => /too_big|expected|received|String must|content:/i.test(a))) extra.push({ kind: "raw-validation-text", detail: `the UI shows validation internals: ${JSON.stringify(alerts)}` });
      if (await c.busy()) extra.push({ kind: "stuck-sending", detail: "the composer is still busy after the Runtime refused the message" });
      // The message never reached the conversation, so the page must not show it as sent either. Plain words and the unsent draft are the warranted outcome.
      return { clients: [c], conversationId: c.conversationId, expected: { alerts: [/could not accept that message/], frames: [/turn\.failed invalid_frame/] }, extra };
    }
  },
  {
    id: "9b", title: "The session hello is refused by the Runtime (binding mismatch)",
    async run(ctx) {
      const first = await ctx.open(); const conversationId = first.conversationId; await first.close();
      const c = await ctx.open({ conversationId, beforeGoto: async (page) => {
        await page.routeWebSocket(/\/v1\/web-chat\/runtime/, (ws) => {
          const server = ws.connectToServer();
          ws.onMessage((m) => server.send(String(m).replace(/"product_id":"[^"]+"/, '"product_id":"00000000-0000-4000-8000-000000000000"')));
          server.onMessage((m) => ws.send(m));
          ws.onClose((code, reason) => server.close({ code, reason })); server.onClose((code, reason) => ws.close({ code, reason }));
        });
      } });
      await sleep(6000);
      const alerts = await c.visibleAlerts();
      ctx.note(`UI after a refused hello: alerts ${JSON.stringify(alerts)}; failed-run controls: ${await c.page.getByRole("button", { name: /retry|answer again/i }).count()}; sockets opened ${c.watch.sockets}`);
      const extra = [];
      if (alerts.some((a) => /reply failed|answer again/i.test(a))) extra.push({ kind: "wrong-error-class", detail: `a refused session is shown as a failed reply: ${JSON.stringify(alerts)}` });
      // The Product named in the rewritten hello does not exist: the web copy for agent_unavailable (not the Registry path) is the warranted outcome (and the Registry's 404 for it).
      return { clients: [c], conversationId, skipUi: true, expected: { alerts: [/This AI is currently unavailable/], logs: [/00000000-0000-4000-8000-000000000000/] }, extra };
    }
  },
  {
    id: "8a", title: "Fresh page load into a conversation whose run (started over the API) is in progress",
    async run(ctx) {
      const seed = await ctx.open(); const conversationId = seed.conversationId; await seed.close();
      const sent = await ctx.world.chat.send(conversationId, ctx.world.productId, { content: STORY });
      ctx.note(`API send -> ${sent.status}`);
      const c = await ctx.open({ conversationId });
      const quiet = await finishOk(ctx, c);
      return { clients: [c], conversationId, extra: quiet ? [] : [{ kind: "no-settle", detail: "UI never became idle" }] };
    }
  },
  {
    id: "8b", title: "Fresh browser (new context, same account) opens a conversation whose run another browser started",
    async run(ctx) {
      const a = await ctx.open({ label: "A" });
      await a.send(STORY); await streaming(a);
      const b = await ctx.open({ label: "B", conversationId: a.conversationId });
      const quietB = await finishOk(ctx, b); const quietA = await finishOk(ctx, a);
      return { clients: [a, b], conversationId: a.conversationId, extra: quietA && quietB ? [] : [{ kind: "no-settle", detail: "a browser never became idle" }] };
    }
  },
  {
    id: "10", title: "Double-click on Start conversation creates one conversation",
    async run(ctx) {
      const c = await ctx.open({ label: "tab", noConversation: true });
      await c.page.goto(`${ctx.web.url}/chat/product/${ctx.world.productId}`);
      await c.page.getByRole("button", { name: /start conversation/i }).first().dblclick();
      await sleep(3000);
      const listed = (await ctx.world.chat.call("GET", `/v1/conversations?product_id=${ctx.world.productId}`)).json?.conversations ?? [];
      c.conversationId = listed[0]?.id;
      // Two concurrent creates under one key race on the unique constraint. The repository resolves it (one conversation, no HTTP error), but the pool logs the lost insert at level error: suspected log noise.
      return { clients: [c], conversationId: c.conversationId, skipUi: true, expected: { logs: [/db_query_error/] }, extra: listed.length === 1 ? [] : [{ kind: "duplicate-create", detail: `${listed.length} conversations exist after one double-click` }] };
    }
  }
];
