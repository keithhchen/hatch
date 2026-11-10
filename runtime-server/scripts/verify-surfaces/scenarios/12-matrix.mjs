import { Scenario } from "../lib/scenario.mjs";
import { Auth, ChatApi, HatchCli, StudioApi } from "../lib/clients.mjs";
import { TelegramWebhooks } from "../lib/webhooks.mjs";
import { FEISHU_CREDENTIALS, FeishuWebhooks, McpClient, PRICE, PricedProduct, WECOM_CREDENTIALS, WeComWebhooks, cliHome, feishuSends, installFeishuResponders, proposeText, walk, wecomSends } from "../lib/matrix-helpers.mjs";
import { randomUUID } from "node:crypto";
import { sleep, until } from "../lib/util.mjs";

const SYSTEM = "You are the Verify Expert. Answer briefly and do exactly what the customer asks. Never call a tool.";
const price = (p) => (p ? `${p.human_hourly_minor}/${p.agent_monthly_minor}` : String(p));

/** A Telegram private chat with the shared bot: what the user types goes in as webhooks, what the bot sends is read from the fake platform. */
class TgChat {
  constructor(stack, hooks, chatId, fromId = chatId) { this.stack = stack; this.hooks = hooks; this.chatId = chatId; this.fromId = fromId; }
  say(text, extra = {}) { return this.hooks.post(this.hooks.message({ chatId: this.chatId, fromId: this.fromId, text, ...extra })); }
  press(data, { fromId = this.fromId } = {}) { return this.hooks.post(this.hooks.callback({ chatId: this.chatId, fromId, data })); }
  sends() { return this.stack.platform.sends().filter((call) => call.body.chat_id === this.chatId); }
  texts() { return this.sends().map((call) => call.body.text); }
  keyboard(call) { return call.body.reply_markup?.inline_keyboard?.[0] ?? []; }
  async waitSends(count, timeoutMs = 150_000) { await until(`${count} sends to chat ${this.chatId}`, () => this.sends().length >= count, { timeoutMs, everyMs: 200 }); return this.sends(); }
  async waitButtons(taskId, timeoutMs = 150_000) { return until(`buttons of task ${taskId} in chat ${this.chatId}`, () => this.sends().find((call) => this.keyboard(call).some((b) => b.callback_data === `t:${taskId}:approve`)), { timeoutMs, everyMs: 200 }); }
}

const taskRows = (stack, accountId) => stack.registryPool.query("SELECT id, kind, status, needs, summary, origin, last_error, payload FROM hatch_assistant_tasks WHERE account_id = $1 ORDER BY created_at", [accountId]).then((r) => r.rows);

/** What one inbound became: inbox rows, Runs and the conversations' owner key on the Runtime, and the outbox rows that carried the reply. */
async function trace(stack, channel, senderId) {
  const inbox = (await stack.registryPool.query("SELECT event_id, state, run_id, attempts FROM hatch_channel_inbox WHERE channel = $1 AND sender_id = $2 ORDER BY seq", [channel, String(senderId)])).rows;
  const runIds = inbox.map((row) => row.run_id).filter(Boolean);
  const runs = runIds.length ? (await stack.runtimePool.query("SELECT r.id, r.status, r.conversation_id, c.public_id, c.owner_account_id, c.product_id FROM hatch_conversation_runs r JOIN hatch_conversations c ON c.id = r.conversation_id WHERE r.id = ANY($1) ORDER BY r.created_at", [runIds])).rows : [];
  const outbox = runIds.length ? (await stack.registryPool.query("SELECT state, source_key, sent_parts, attempts FROM hatch_channel_outbox WHERE source_key = ANY($1) ORDER BY seq", [runIds.map((id) => `run:${id}`)])).rows : [];
  return { inbox, runs, outbox };
}

class Matrix extends Scenario {
  constructor() { super({ id: 12, title: "The 2x2 matrix walked end to end: coding agent and IM (Telegram, Feishu, WeCom) to Studio and Chat" }); }

  async run(stack, rec) {
    const matrix = {};
    const hasKimi = Boolean(process.env.LLM_API_KEY);
    rec.note("Fakes in this scenario: the fake messaging platform (incl. Feishu token/bot-info responders added here), and DB-inserted org/public/self-product Connections (no product API creates them). Everything else is the real product through its real doors.");
    if (!hasKimi) rec.note("LLM_API_KEY is absent: the Assistant (pinned to kimi-k2.6) cannot run, so every Studio cell is BLOCKED.");
    installFeishuResponders(stack.platform);
    const groups = [
      ["coding agent -> Studio", () => this.codingAgentToStudio(stack, rec, matrix, hasKimi)],
      ["coding agent -> Chat", () => this.codingAgentToChat(stack, rec, matrix)],
      ["Telegram -> Studio", () => this.telegramToStudio(stack, rec, matrix, hasKimi)],
      ["Telegram -> Chat", () => this.telegramToChat(stack, rec, matrix)],
      ["Feishu/WeCom", () => this.ownApps(stack, rec, matrix, hasKimi)]
    ];
    await Promise.all(groups.map(async ([name, group]) => { try { await group(); } catch (error) { rec.check(`group ${name} ran to the end`, false, String(error?.stack ?? error).slice(0, 600)); } }));
    rec.evidenceOf("matrix", Object.fromEntries(Object.entries(matrix).sort(([a], [b]) => a.localeCompare(b))));
    const tally = {}; for (const cell of Object.values(matrix)) tally[cell.status] = (tally[cell.status] ?? 0) + 1;
    rec.measure("cells", tally);
  }

  // ── Row 1: a coding agent ────────────────────────────────────────────

  /** One walk of the confirmation flow: propose A, propose B, decline B, approve A, and the price only moves when confirmed. */
  async confirmationFlow(cell, { priced, ask, approve, decline, readPrice, via }) {
    const known = new Set();
    cell.check("price before the change is the initial one", PricedProduct.same(await readPrice(), PRICE.before), price(await readPrice()));

    const askedA = await ask(proposeText(priced.id, PRICE.approved));
    const taskA = await priced.nextChange(known, PRICE.approved); known.add(taskA.id); cell.ids.approvedTask = taskA.id;
    cell.check("the Assistant created a pending change task (needs_you, review)", taskA.status === "needs_you" && taskA.needs === "review", { id: taskA.id, status: taskA.status, needs: taskA.needs, origin: taskA.origin, summary: taskA.summary });
    cell.check("the task carries the proposed pricing and the right Product", Number(taskA.payload.change.pricing.agent_monthly_minor) === PRICE.approved.agent_monthly_minor, taskA.payload);
    await sleep(5000);
    cell.check("an unconfirmed task does not change the price", PricedProduct.same(await readPrice(), PRICE.before), price(await readPrice()));
    cell.check("the Assistant did not confirm it by itself", (await priced.task(taskA.id)).status === "needs_you");
    cell.ids.askedA = askedA;

    await ask(proposeText(priced.id, PRICE.declined));
    const taskB = await priced.nextChange(known, PRICE.declined); known.add(taskB.id); cell.ids.declinedTask = taskB.id;
    const declined = await decline(taskB.id);
    cell.check(`${via}: decline accepted`, declined.ok, declined.detail);
    await sleep(1500);
    cell.check("a declined task does not change the price", PricedProduct.same(await readPrice(), PRICE.before), price(await readPrice()));
    const declinedRow = await priced.task(taskB.id);
    cell.check("the declined task is done and says it was cancelled", declinedRow.status === "done" && /已取消/.test(declinedRow.summary ?? ""), { status: declinedRow.status, summary: declinedRow.summary });

    const approved = await approve(taskA.id);
    cell.check(`${via}: approve accepted`, approved.ok, approved.detail);
    const after = await until("price to change after confirmation", async () => { const now = await readPrice(); return PricedProduct.same(now, PRICE.approved) ? now : undefined; }, { timeoutMs: 15_000, everyMs: 300 }).catch(() => readPrice());
    cell.check("only after the confirmation is the price the new one", PricedProduct.same(after, PRICE.approved), { before: price(PRICE.before), after: price(after) });
    const approvedRow = await priced.task(taskA.id);
    cell.check("the approved task is done and says it was confirmed", approvedRow.status === "done" && /已确认/.test(approvedRow.summary ?? ""), { status: approvedRow.status, summary: approvedRow.summary });
    const again = await approve(taskA.id);
    cell.check("approving the same task again is refused", !again.ok, again.detail);
    const revive = await approve(taskB.id);
    cell.check("a declined task cannot be approved afterwards", !revive.ok && PricedProduct.same(await readPrice(), PRICE.approved), { revive: revive.detail, price: price(await readPrice()) });
  }

  async codingAgentToStudio(stack, rec, matrix, hasKimi) {
    if (!hasKimi) { for (const id of ["1a", "1b"]) matrix[id] = { status: "BLOCKED", reason: "LLM_API_KEY (kimi-k2.6) is absent, the Studio Assistant cannot run" }; return; }
    const httpDecision = (studio) => ({
      approve: async (id) => { const r = await studio.call("POST", `/v1/creator/assistant/tasks/${id}/approve`, { body: {} }); return { ok: r.status === 200, detail: { status: r.status, body: r.text.slice(0, 160) } }; },
      decline: async (id) => { const r = await studio.call("POST", `/v1/creator/assistant/tasks/${id}/decline`, { body: {} }); return { ok: r.status === 200, detail: { status: r.status, body: r.text.slice(0, 160) } }; }
    });

    await walk(matrix, rec, "1a", "coding agent (CLI) -> Studio: create a Product, ask the Assistant to change its price, confirm", async (cell) => {
      const account = await stack.account("cli-coder");
      const studio = new StudioApi(stack.url, Auth.bearer(account.apiKey));
      const cli = new HatchCli({ apiUrl: stack.url, apiKey: account.apiKey, home: cliHome(stack, "studio-cli") });
      const run = async (...args) => (await cli.run(args).done);
      const whoami = await run("whoami");
      cell.check("hatch whoami with the API key", whoami.code === 0 && whoami.json?.account?.id === account.id, { code: whoami.code, id: whoami.json?.account?.id });
      const created = await run("products", "create", "--name", "Matrix CLI Product", "--promise", "A verification Product created from the hatch CLI");
      const productId = created.json?.product_id ?? created.json?.id; cell.ids.productId = productId;
      cell.check("hatch products create returned a Product id (real Registry, POST /v1/creator/products)", created.code === 0 && Boolean(productId), { code: created.code, stdout: created.stdout.slice(0, 200) });
      rec.note("hatch CLI has no pricing command: the Product's initial price is set through PUT /v1/creator/products/:id/pricing (the Studio route).");
      const priced = new PricedProduct(stack, studio, account); await priced.create(null, productId);
      const readPrice = async () => (await run("products", "show", productId)).json?.pricing;
      await this.confirmationFlow(cell, {
        priced, readPrice, via: "Studio HTTP",
        ask: async (text) => { const r = await run("assistant", text, "--wait=120"); cell.check("hatch assistant --wait exited 0", r.code === 0, { code: r.code, stderr: r.stderr.slice(0, 200), stdout: r.stdout.slice(0, 300) }); return r.json; },
        ...httpDecision(studio)
      });
      rec.note("No hatch command or MCP tool confirms or declines an Assistant task: the confirmation is POST /v1/creator/assistant/tasks/:id/(approve|decline) (Studio web) or an IM button. The coding agent can propose, not confirm.");
    });

    await walk(matrix, rec, "1b", "coding agent (MCP, hatch mcp over stdio) -> Studio: same flow through MCP tools", async (cell) => {
      const account = await stack.account("mcp-coder");
      const studio = new StudioApi(stack.url, Auth.bearer(account.apiKey));
      const mcp = new McpClient({ apiUrl: stack.url, apiKey: account.apiKey, home: cliHome(stack, "studio-mcp") });
      try {
        const init = await mcp.start();
        cell.check("MCP initialize", init?.serverInfo?.name === "hatch", init);
        const tools = (await mcp.request("tools/list", {})).tools.map((tool) => tool.name);
        cell.ids.tools = tools;
        cell.check("MCP lists products_create, products_show, assistant_send", ["products_create", "products_show", "assistant_send"].every((t) => tools.includes(t)), tools);
        const created = await mcp.tool("products_create", { name: "Matrix MCP Product", promise: "A verification Product created over MCP" });
        const productId = created.json?.product_id ?? created.json?.id; cell.ids.productId = productId;
        cell.check("products_create returned a Product id", !created.isError && Boolean(productId), created.text.slice(0, 200));
        const priced = new PricedProduct(stack, studio, account); await priced.create(null, productId);
        await this.confirmationFlow(cell, {
          priced, via: "Studio HTTP", readPrice: async () => (await mcp.tool("products_show", { product_id: productId })).json?.pricing,
          ask: async (text) => { const r = await mcp.tool("assistant_send", { content: text, wait: 120 }); cell.check("assistant_send returned without a tool error", !r.isError, r.text.slice(0, 300)); return r.json; },
          ...httpDecision(studio)
        });
      } finally { mcp.close(); }
    });
  }

  async codingAgentToChat(stack, rec, matrix) {
    const owner = await stack.account("chat-coder");
    // The CLI/MCP surface is measured on conversations the Chat HTTP door started (with brief_answers: []), continued with --conversation / conversation_id; starting through `hatch ask` is cell 2c.
    const productId = await stack.product(owner, { system: SYSTEM });
    const started = (product) => chat.create(product, randomUUID(), []);
    const chat = new ChatApi(stack.url, Auth.bearer(owner.apiKey));
    const cli = new HatchCli({ apiUrl: stack.url, apiKey: owner.apiKey, home: cliHome(stack, "chat-cli") });
    const run = (...args) => cli.run(args).done;

    await walk(matrix, rec, "2a", "coding agent (CLI) -> Chat: ask --wait, --stream, show, watch, stop", async (cell) => {
      cell.ids.productId = productId;
      const cid = await started(productId);
      const first = await run("ask", "Reply with exactly the word: pong", "--product", productId, "--conversation", cid, "--wait=60");
      cell.ids.conversationId = cid; cell.ids.firstRun = first.json?.run_id;
      cell.check("ask --wait: completed with the reply", first.code === 0 && first.json?.status === "completed" && /pong/i.test(first.json?.reply?.text ?? ""), { code: first.code, status: first.json?.status, reply: first.json?.reply, stderr: first.stderr.slice(0, 200) });
      const second = await run("ask", "Reply with exactly the word: ping", "--product", productId, "--conversation", cid, "--wait=60");
      cell.check("ask --conversation continues the same conversation with a new Run", second.json?.conversation_id === cid && second.json?.run_id && second.json.run_id !== first.json?.run_id && /ping/i.test(second.json?.reply?.text ?? ""), { run: second.json?.run_id, reply: second.json?.reply });
      const streamed = await run("ask", "Reply with exactly the word: streamed", "--product", productId, "--conversation", cid, "--stream");
      cell.ids.streamRun = streamed.json?.run_id;
      cell.check("ask --stream: the Run completed and the streamed reply carries the answer", streamed.code === 0 && streamed.json?.status === "completed" && /streamed/i.test(streamed.json?.reply?.text ?? ""), { code: streamed.code, json: streamed.json, stderr: streamed.stderr.slice(0, 200) });
      const show = await run("conversation", "show", cid, "--product", productId);
      cell.check("conversation show: runs, messages, cursor and the latest Run", show.code === 0 && show.json?.runs?.length === 3 && show.json?.messages?.length >= 6 && show.json?.cursor !== undefined && show.json?.status === "completed", { runs: show.json?.runs?.length, messages: show.json?.messages?.length, cursor: show.json?.cursor, status: show.json?.status });
      const watch = await run("conversation", "watch", cid, "--product", productId, "--after", "0");
      cell.check("conversation watch --after 0 replays from the start and ends at the first Run's end with its status", watch.code === 0 && watch.json?.status === "completed" && watch.json?.run_id === first.json?.run_id, { code: watch.code, ms: watch.ms, json: watch.json, stderr: watch.stderr.slice(0, 200) });
      rec.measure("cli_watch_replay_reply_chars", (watch.json?.reply?.text ?? "").length);
      rec.note("conversation watch --after 0 on finished Runs ends at the FIRST Run's end and carries no reply text (deltas are not replayed); catching up on history is conversation show. Watching a live Run from now returns the full reply.");
      const list = await run("conversations", "--product", productId);
      cell.check("conversations lists the conversation", list.json?.conversations?.some((c) => c.id === cid), list.stdout.slice(0, 200));

      // watch a live Run to its end, then stop another: Runs held open by a slow server tool
      const stopProduct = await stack.product(owner, { name: "Slow Expert", system: "You are a research Expert. For every question first call the web_search tool exactly once with the question as the query, then answer in one sentence: the answer only, naming the city." });
      stack.platform.search.delayMs = 8_000;
      try {
        const liveCid = await started(stopProduct);
        const live = await run("ask", "What is the capital of France?", "--product", stopProduct, "--conversation", liveCid);
        const watcher = await run("conversation", "watch", liveCid, "--product", stopProduct);
        cell.check("watching a live Run (from now) ends at its end with the full reply (Paris)", live.code === 0 && watcher.code === 0 && watcher.json?.status === "completed" && /paris/i.test(watcher.json?.reply?.text ?? ""), { askCode: live.code, watchMs: watcher.ms, watch: watcher.json, stderr: watcher.stderr.slice(0, 200) });
      } finally { stack.platform.search.delayMs = 0; }
      stack.platform.search.delayMs = 25_000;
      try {
        const stopCid = await started(stopProduct);
        const seen = stack.platform.search.calls.length;
        const accepted = await run("ask", "What is the capital of Spain?", "--product", stopProduct, "--conversation", stopCid);
        const runId = accepted.json?.run_id;
        cell.check("ask without --wait is accepted with a run id", accepted.code === 0 && Boolean(runId), { code: accepted.code, json: accepted.json });
        await until("the Run to wait on the slow tool", async () => stack.platform.search.calls.length > seen, { timeoutMs: 40_000, everyMs: 200 }).catch(() => undefined);
        const stopped = await run("conversation", "stop", stopCid, runId, "--product", stopProduct);
        const final = await chat.finish(stopCid, stopProduct, runId, 30_000).catch((error) => ({ status: `unfinished: ${error.message}` }));
        cell.ids.stoppedRun = runId;
        cell.check("conversation stop cancels a running Run", stopped.code === 0 && final.status === "cancelled", { stopCode: stopped.code, stdout: stopped.stdout.slice(0, 200), final: final.status, searchCalls: stack.platform.search.calls.length });
      } finally { stack.platform.search.delayMs = 0; }
    });

    await walk(matrix, rec, "2b", "coding agent (MCP) -> Chat: chat_send, conversation_show, chat_stop, conversations_list", async (cell) => {
      const mcp = new McpClient({ apiUrl: stack.url, apiKey: owner.apiKey, home: cliHome(stack, "chat-mcp") });
      try {
        await mcp.start();
        const cid = await started(productId);
        const sent = await mcp.tool("chat_send", { product_id: productId, conversation_id: cid, content: "Reply with exactly the word: mcp-pong", wait: 60 });
        cell.ids.conversationId = cid; cell.ids.run = sent.json?.run_id;
        cell.check("chat_send wait=60: reply", !sent.isError && sent.json?.status === "completed" && /mcp-pong/i.test(sent.json?.reply?.text ?? ""), sent.text.slice(0, 300));
        const shown = await mcp.tool("conversation_show", { product_id: productId, conversation_id: cid });
        cell.check("conversation_show: messages and the Run's status", !shown.isError && shown.json?.status === "completed" && shown.json?.messages?.length >= 2, shown.text.slice(0, 200));
        const listed = await mcp.tool("conversations_list", { product_id: productId });
        cell.check("conversations_list includes it", listed.json?.conversations?.some((c) => c.id === cid), listed.text.slice(0, 200));
        stack.platform.search.delayMs = 25_000;
        try {
          const stopProduct = await stack.product(owner, { name: "Slow Expert MCP", system: "You are a research Expert. For every question first call the web_search tool exactly once with the question as the query, then answer in one sentence." });
          const stopCid = await started(stopProduct);
          const accepted = await mcp.tool("chat_send", { product_id: stopProduct, conversation_id: stopCid, content: "What is the capital of Japan?" });
          const runId = accepted.json?.run_id;
          cell.check("chat_send without wait returns a run id", !accepted.isError && Boolean(runId), accepted.text.slice(0, 200));
          await until("the Run to wait on the slow tool", async () => stack.platform.search.calls.length > 0, { timeoutMs: 40_000, everyMs: 200 }).catch(() => undefined);
          const stopped = await mcp.tool("chat_stop", { product_id: stopProduct, conversation_id: stopCid, run_id: runId });
          const final = await chat.finish(stopCid, stopProduct, runId, 30_000).catch((error) => ({ status: `unfinished: ${error.message}` }));
          cell.check("chat_stop cancels a running Run", !stopped.isError && final.status === "cancelled", { stop: stopped.text.slice(0, 160), final: final.status });
        } finally { stack.platform.search.delayMs = 0; }
      } finally { mcp.close(); }
    });

    await walk(matrix, rec, "2c", "coding agent (CLI, MCP) -> Chat on Products with a brief spec: optional-only field, required field (answered via --brief / brief_answers), no brief spec", async (cell) => {
      const mcp = new McpClient({ apiUrl: stack.url, apiKey: owner.apiKey, home: cliHome(stack, "chat-brief") });
      await mcp.start();
      try {
        const specs = {
          optional: { contract_version: "1", fields: [{ id: "goal", label: "What should we achieve?", required: false }] },
          required: { contract_version: "1", fields: [{ id: "goal", label: "What should we achieve?", required: true }] },
          none: null
        };
        const outcomes = {};
        for (const [kind, brief] of Object.entries(specs)) {
          const product = await stack.product(owner, { name: `Brief ${kind}`, system: SYSTEM, brief });
          const create = (answers) => chat.call("POST", `/v1/conversations${chat.q(product)}`, { body: { client_request_id: `brief-${kind}-${Math.random()}`, ...(answers ? { brief_answers: answers } : {}) } });
          const noAnswers = await create(undefined);
          const emptyAnswers = await create([]);
          const withAnswer = await create([{ field_id: "goal", value: "verify the brief path" }]);
          const answered = kind === "required";
          const viaCli = await run("ask", "Reply with exactly the word: briefed", "--product", product, "--wait=60", ...(answered ? ["--brief", "goal=verify the brief path"] : []));
          const viaMcp = await mcp.tool("chat_send", { product_id: product, content: "Reply with exactly the word: briefed", wait: 60, ...(answered ? { brief_answers: { goal: "verify the brief path" } } : {}) });
          outcomes[kind] = { product, httpNoAnswers: noAnswers.status, httpEmptyAnswers: emptyAnswers.status, httpWithAnswer: withAnswer.status, cliExit: viaCli.code, cliError: viaCli.stderr.slice(0, 160), mcpError: viaMcp.isError ? viaMcp.text.slice(0, 160) : undefined, cliReply: viaCli.json?.reply?.text, mcpReply: viaMcp.json?.reply?.text };
          if (kind === "required") {
            const refusedCli = await run("ask", "x", "--product", product, "--wait=60");
            const refusedMcp = await mcp.tool("chat_send", { product_id: product, content: "x", wait: 60 });
            outcomes[kind].unansweredCli = /brief_required_answer_missing/.test(refusedCli.stderr);
            outcomes[kind].unansweredMcp = refusedMcp.isError && /Answers required in brief_answers/.test(refusedMcp.text);
          }
        }
        cell.ids.outcomes = outcomes; rec.evidenceOf("brief_outcomes", outcomes);
        cell.check("precondition: the HTTP door starts a conversation when the spec's required fields are answered, refuses a missing required answer with 422, and does not need answers for an optional-only spec", outcomes.optional.httpNoAnswers < 300 && outcomes.optional.httpEmptyAnswers < 300 && outcomes.required.httpWithAnswer < 300 && outcomes.required.httpNoAnswers === 422, outcomes);
        cell.check("a Product without a brief spec is refused by Chat itself (403: every Product requires a BriefSpec), also through the CLI and MCP", outcomes.none.httpNoAnswers === 403 && outcomes.none.cliExit !== 0 && /BriefSpec/.test(outcomes.none.cliError) && /BriefSpec/.test(outcomes.none.mcpError ?? ""), outcomes.none);
        const optionalOk = outcomes.optional.cliExit === 0 && /briefed/i.test(outcomes.optional.cliReply ?? "") && /briefed/i.test(outcomes.optional.mcpReply ?? "");
        cell.check("hatch ask / MCP chat_send chat a Product whose brief spec has only OPTIONAL fields", optionalOk, outcomes.optional);
        const requiredOk = outcomes.required.cliExit === 0 && /briefed/i.test(outcomes.required.cliReply ?? "") && /briefed/i.test(outcomes.required.mcpReply ?? "");
        cell.check("hatch ask --brief field=value / MCP chat_send brief_answers chat a Product whose brief spec has a REQUIRED field", requiredOk, outcomes.required);
        cell.check("without the answer, hatch ask / MCP chat_send are refused with 422 brief_required_answer_missing naming the field", outcomes.required.unansweredCli && outcomes.required.unansweredMcp, outcomes.required);

      } finally { mcp.close(); }
    });
  }

  // ── Row 2 x Studio: IM to the Assistant ──────────────────────────────

  async telegramToStudio(stack, rec, matrix, hasKimi) {
    if (!hasKimi) { for (const id of ["3a", "3b", "3c", "3d"]) matrix[id] = { status: "BLOCKED", reason: "LLM_API_KEY (kimi-k2.6) is absent, the Studio Assistant cannot run" }; return; }
    const account = await stack.account("tg-owner");
    const studio = new StudioApi(stack.url, Auth.bearer(account.apiKey));
    const hooks = new TelegramWebhooks(stack.registryUrl);
    const tg = new TgChat(stack, hooks, 7001);
    const priced = new PricedProduct(stack, studio, account);
    let linked = false;

    await walk(matrix, rec, "3a", "Telegram -> Studio: link a self Assistant Connection with the real code flow, then dispatch a task", async (cell) => {
      const connect = await studio.call("POST", "/v1/creator/connections/telegram/connect", { body: {} });
      const code = connect.json?.code; cell.ids.connectUrl = connect.json?.url;
      cell.check("connect returned a HATCH- code and the bot's t.me link", connect.status === 200 && /^HATCH-[A-Z0-9]{8}$/.test(code ?? "") && (connect.json?.url ?? "").includes(code), { status: connect.status, url: connect.json?.url });
      const posted = await tg.say(code);
      cell.check("the webhook carrying the code is accepted (200)", posted.status === 200, posted);
      const [welcome] = await tg.waitSends(1, 30_000);
      linked = true;
      cell.check("the bot answers the code with the connected notice", /连上了/.test(welcome.body.text), welcome.body.text);
      const connection = (await stack.registryPool.query("SELECT c.id, c.audience, c.target_key, i.sender_id, i.thread_id FROM hatch_connections c JOIN hatch_channel_identities i ON i.connection_id = c.id WHERE c.owner_account_id = $1 AND c.channel = 'telegram'", [account.id])).rows;
      cell.ids.connection = connection[0]?.id;
      cell.check("a self Assistant Connection is linked to the sender's private chat", connection.length === 1 && connection[0].audience === "self" && connection[0].target_key === "assistant" && connection[0].sender_id === "7001", connection);
      const reuse = await studio.call("POST", "/v1/creator/connections/telegram/connect", { body: {} });
      const replay = await tg.say(code);
      await sleep(2500);
      cell.check("a used code does not link again (the replayed code gets the expired notice)", replay.status === 200 && tg.texts().some((t) => /已失效/.test(t)) && reuse.status === 200, tg.texts());

      const before = (await taskRows(stack, account.id)).length; const sendsBefore = tg.sends().length;
      await tg.say("请调用 start_task 工具，kind 为 research，instruction 为：专家是 Verify Expert，一位验证用的虚构专家，没有任何公开资料，读不到就如实说。不要问我问题。");
      const task = await until("a research task", async () => (await taskRows(stack, account.id)).find((row) => row.kind === "research"), { timeoutMs: 150_000, everyMs: 500 });
      cell.ids.researchTask = task.id;
      cell.check("dispatch: the Assistant created a research task originating from Telegram", task.origin?.source === "telegram", { origin: task.origin, status: task.status });
      await tg.waitSends(sendsBefore + 1, 120_000);
      cell.check("the Assistant answered on the platform", tg.sends().length > sendsBefore && tg.sends().at(-1).body.text.trim().length > 0, tg.texts().slice(sendsBefore));
      const settled = await until("the research task to leave working", async () => { const row = (await taskRows(stack, account.id)).find((r) => r.id === task.id); return row?.status !== "working" ? row : undefined; }, { timeoutMs: 180_000, everyMs: 2000 }).catch(() => undefined);
      const latest = (await taskRows(stack, account.id)).find((r) => r.id === task.id);
      rec.measure("research_task_final_state", { status: latest.status, needs: latest.needs, lastError: latest.last_error, settledInTime: Boolean(settled), taskRowsBefore: before });
      cell.check("the research worker did not end in an error", !latest.last_error, latest.last_error);
      cell.ids.platformTextsAfterDispatch = tg.texts().slice(sendsBefore).map((t) => t.slice(0, 120));
    });

    const confirm = async (cell, tgChat, label, newPrice, press, expectNew) => {
      const known = new Set((await priced.tasks()).map((t) => t.id));
      const sendsBefore = tgChat.sends().length;
      await tgChat.say(proposeText(priced.id, newPrice));
      const task = await priced.nextChange(known, newPrice);
      const card = await tgChat.waitButtons(task.id);
      const keyboard = tgChat.keyboard(card);
      return { task, card, keyboard, sendsBefore };
    };

    await walk(matrix, rec, "3b", "Telegram -> Studio: a price change confirmed with the inline 确认 button (callback_query)", async (cell) => {
      if (!linked) cell.block("the self Assistant Connection was not linked in 3a");
      await priced.create("Matrix Telegram Product");
      cell.ids.productId = priced.id;
      const approvedPrice = PRICE.approved;
      const { task, keyboard } = await confirm(cell, tg, "approve", approvedPrice);
      cell.ids.approvedTask = task.id;
      cell.check("the pending task's outbound message carries inline buttons 确认 and 取消 with callback_data t:<task>:approve|decline", keyboard.length === 2 && keyboard[0].text === "确认" && keyboard[0].callback_data === `t:${task.id}:approve` && keyboard[1].text === "取消" && keyboard[1].callback_data === `t:${task.id}:decline`, keyboard);
      await sleep(3000);
      cell.check("before the button is pressed the price is unchanged", PricedProduct.same((await priced.price()).pricing, PRICE.before), (await priced.price()).pricing);
      const callsBefore = stack.platform.calls.length;
      const pressed = await tg.press(keyboard[0].callback_data);
      cell.check("the callback_query webhook from the linked sender is accepted", pressed.status === 200, pressed);
      const done = await until("task done", async () => { const r = await priced.task(task.id); return r.status === "done" ? r : undefined; }, { timeoutMs: 30_000, everyMs: 300 }).catch(() => priced.task(task.id));
      cell.check("pressing 确认 completes the task as confirmed", done.status === "done" && /已确认/.test(done.summary ?? ""), { status: done.status, summary: done.summary });
      cell.check("and only then the price is the new one", PricedProduct.same((await priced.price()).pricing, approvedPrice), { before: price(PRICE.before), after: price((await priced.price()).pricing) });
      const calls = stack.platform.calls.slice(callsBefore);
      const answered = calls.find((c) => c.method === "answerCallbackQuery");
      const cleared = calls.find((c) => c.method === "editMessageReplyMarkup");
      cell.check("the platform got answerCallbackQuery and the buttons were removed (editMessageReplyMarkup)", Boolean(answered) && Boolean(cleared) && (cleared.body.reply_markup?.inline_keyboard ?? [1]).length === 0, { answered: answered?.body, cleared: cleared?.body });
      const replay = await tg.press(keyboard[0].callback_data);
      await sleep(2500);
      const refusals = stack.platform.calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text);
      cell.check("pressing the same button again is refused and the price stays", replay.status === 200 && refusals.some((t) => /不需要确认/.test(t ?? "")) && PricedProduct.same((await priced.price()).pricing, approvedPrice), { refusals });
      await sleep(5000);
      cell.ids.assistantFollowUp = tg.texts().slice(-2).map((t) => t.slice(0, 120));
    });

    await walk(matrix, rec, "3c", "Telegram -> Studio: a price change declined with the 取消 button", async (cell) => {
      if (!linked || !priced.id) cell.block("3a/3b did not set up the linked Connection and the priced Product");
      const { task, keyboard } = await confirm(cell, tg, "decline", PRICE.declined);
      cell.ids.declinedTask = task.id;
      const pressed = await tg.press(keyboard[1].callback_data);
      cell.check("the 取消 callback is accepted", pressed.status === 200, pressed);
      const done = await until("task done", async () => { const r = await priced.task(task.id); return r.status === "done" ? r : undefined; }, { timeoutMs: 30_000, everyMs: 300 }).catch(() => priced.task(task.id));
      cell.check("the task is done and cancelled", done.status === "done" && /已取消/.test(done.summary ?? ""), { status: done.status, summary: done.summary });
      cell.check("the price did not change", PricedProduct.same((await priced.price()).pricing, PRICE.approved), (await priced.price()).pricing);
    });

    await walk(matrix, rec, "3d", "Telegram -> Studio: a stranger cannot reach the Assistant or press the owner's buttons", async (cell) => {
      if (!linked || !priced.id) cell.block("3a/3b did not set up the linked Connection and the priced Product");
      const strange = { human_hourly_minor: 40000, agent_monthly_minor: 6900 };
      const { task, keyboard } = await confirm(cell, tg, "stranger", strange);
      const stranger = new TgChat(stack, hooks, 9999);
      const direct = await stranger.press(keyboard[0].callback_data);
      const spoof = await hooks.post(hooks.callback({ chatId: 7001, fromId: 9998, data: keyboard[0].callback_data }));
      const text = await stranger.say("请调用 start_task 工具，kind 为 research，instruction 为 x");
      await sleep(5000);
      const row = await priced.task(task.id);
      cell.check("a stranger's approve (own chat or the owner's chat id) does not apply the change", direct.status === 200 && spoof.status === 200 && row.status === "needs_you" && PricedProduct.same((await priced.price()).pricing, PRICE.approved), { status: row.status, price: price((await priced.price()).pricing) });
      cell.check("the stranger is offered sign-in and nothing was dispatched", stranger.texts().some((t) => /登录 Hatch，就能在这里和助理聊了/.test(t)) && text.status === 200 && (await taskRows(stack, account.id)).filter((r) => r.kind === "research").length === 1, stranger.texts());
      await tg.press(keyboard[1].callback_data);
    });
  }

  // ── Row 2 x Chat: IM to a Product, three audiences ───────────────────

  async telegramToChat(stack, rec, matrix) {
    const owner = await stack.account("chat-im-owner");
    const productId = await stack.ownedProduct(owner, { system: SYSTEM });
    const hooks = new TelegramWebhooks(stack.registryUrl);
    const chat = new ChatApi(stack.url, Auth.bearer(owner.apiKey));
    const one = async (tg, text) => { const before = tg.sends().length; const posted = await tg.say(text); const sends = await tg.waitSends(before + 1, 120_000); return { posted, reply: sends[before].body.text, count: before + 1 }; };

    await walk(matrix, rec, "4a", "Telegram -> Chat, audience self: the owner's own Product, account principal", async (cell) => {
      const connection = await stack.connection({ owner, audience: "self", productId }); await stack.admit(connection, { senderId: "6001" });
      const tg = new TgChat(stack, hooks, 6001); cell.ids.connection = connection;
      const posted = await tg.say("Reply with exactly the word: self-ok");
      cell.check("the webhook is accepted", posted.status === 200, posted);
      const outcome = await until("a reply or the inbox giving up", async () => { if (tg.sends().length) return "replied"; const rows = (await trace(stack, "telegram", 6001)).inbox; return rows[0]?.state === "failed" ? "failed" : undefined; }, { timeoutMs: 120_000, everyMs: 500 }).catch(() => "neither");
      await sleep(3000);
      const t = await trace(stack, "telegram", 6001); cell.ids.trace = t; cell.ids.platformTexts = tg.texts(); cell.ids.outcome = outcome;
      const lastError = (await stack.registryPool.query("SELECT last_error, attempts, state FROM hatch_channel_inbox WHERE sender_id = '6001'")).rows[0];
      cell.ids.inboxFinal = lastError;
      cell.check("one inbound gets a reply with the answer", tg.sends().length === 1 && /self-ok/i.test(tg.texts()[0] ?? ""), { outcome, sends: tg.texts(), inbox: lastError });
      cell.check("one inbound -> one inbox row -> one Run", t.inbox.length === 1 && t.runs.length === 1 && t.runs[0].status === "completed", { inbox: t.inbox, runs: t.runs.map((r) => ({ id: r.id, status: r.status })) });
      cell.check("self -> account principal: the conversation belongs to the owner's account", t.runs[0]?.owner_account_id === owner.id && t.runs[0]?.product_id === productId, { runs: t.runs.length });
      if (!t.runs.length) rec.defect({ title: "A self Product Connection never answers: the sender gets no reply and no notice, the inbound ends `failed`", severity: "high", expected: "Spec: `self` => account principal for a Product too; the owner texting their own Product from a linked chat gets one final reply", actual: `The Registry ProductTarget sends a thread-ref to Chat with an account principal; the Runtime's account binder only accepts conversation refs and throws ChatError binding_unavailable 503 ('Account messages are not configured on this Runtime.'). ProductTarget treats only <500/501/'unavailable' as refusals, so the event is retried and ends state=${lastError?.state} after ${lastError?.attempts} attempts (last_error: ${lastError?.last_error}). The platform received ${tg.sends().length} messages, no Run was created`, repro: "stack.connection({audience:'self', productId}); stack.admit(sender); POST a Telegram private message from that sender. Code: runtime-server/src/index.ts chatGatewayFor binders.account (ref.kind !== 'conversation' -> unavailable('Account')), channels/productTarget.ts catch" });
    });

    await walk(matrix, rec, "4b", "Telegram -> Chat, audience org: admitted members as contacts, isolated; a non-admitted sender is refused", async (cell) => {
      const connection = await stack.connection({ owner, audience: "org", productId }); cell.ids.connection = connection;
      await stack.admit(connection, { senderId: "6101" }); await stack.admit(connection, { senderId: "6102" });
      const m1 = new TgChat(stack, hooks, 6101); const m2 = new TgChat(stack, hooks, 6102); const outsider = new TgChat(stack, hooks, 6199);
      const [r1, r2] = await Promise.all([one(m1, "My secret code word is BLUEBIRD. Reply with exactly the word: noted"), one(m2, "My secret code word is REDFOX. Reply with exactly the word: noted")]);
      cell.check("each member gets one reply to their message", /noted/i.test(r1.reply) && /noted/i.test(r2.reply), { r1: r1.reply, r2: r2.reply });
      const [a1, a2] = await Promise.all([one(m1, "What secret code word did I tell you earlier? Answer with just the word."), one(m2, "What secret code word did I tell you earlier? Answer with just the word.")]);
      cell.check("each member's conversation remembers only their own word", /BLUEBIRD/i.test(a1.reply) && !/REDFOX/i.test(a1.reply) && /REDFOX/i.test(a2.reply) && !/BLUEBIRD/i.test(a2.reply), { m1: a1.reply, m2: a2.reply });
      await sleep(7000);
      const t1 = await trace(stack, "telegram", 6101); const t2 = await trace(stack, "telegram", 6102); cell.ids.traces = { m1: t1.runs.map((r) => r.id), m2: t2.runs.map((r) => r.id) };
      cell.check("each member: two inbounds -> two Runs in ONE conversation, two replies sent once each", [t1, t2].every((t, i) => t.runs.length === 2 && new Set(t.runs.map((r) => r.conversation_id)).size === 1 && t.outbox.length === 2 && t.outbox.every((o) => o.state === "sent")) && m1.sends().length === 2 && m2.sends().length === 2, { m1: { runs: t1.runs.length, convs: new Set(t1.runs.map((r) => r.conversation_id)).size, outbox: t1.outbox.length }, m2: { runs: t2.runs.length, convs: new Set(t2.runs.map((r) => r.conversation_id)).size, outbox: t2.outbox.length } });
      const c1 = t1.runs[0]?.conversation_id; const c2 = t2.runs[0]?.conversation_id;
      cell.check("two members' conversations are distinct", Boolean(c1) && Boolean(c2) && c1 !== c2, { c1, c2 });
      cell.check("org members are contacts: each conversation is owned by contact:<connection>:<contact>, never the owner's account", [t1, t2].every((t) => t.runs.every((r) => r.owner_account_id.startsWith(`contact:${connection}:`) && r.owner_account_id !== owner.id)) && t1.runs[0].owner_account_id !== t2.runs[0].owner_account_id, { m1: t1.runs[0]?.owner_account_id, m2: t2.runs[0]?.owner_account_id, owner: owner.id });
      cell.ids.principals = { m1: t1.runs[0]?.owner_account_id, m2: t2.runs[0]?.owner_account_id };
      const dup = new TelegramWebhooks(stack.registryUrl); const update = dup.message({ chatId: 6101, text: "Reply with exactly the word: dedupe", updateId: 424242 });
      await dup.post(update); await dup.post(update);
      await sleep(12_000);
      const t3 = await trace(stack, "telegram", 6101);
      cell.check("the same update posted twice is one Run (database dedupe) and one more reply", t3.inbox.filter((r) => r.event_id === "424242").length === 1 && t3.runs.length === 3 && m1.sends().length === 3, { inbox: t3.inbox.length, runs: t3.runs.length, sends: m1.sends().length });
      const leaked = async (conversationId, word) => Number((await stack.runtimePool.query("SELECT count(*)::int AS n FROM hatch_conversation_events WHERE conversation_id = $1 AND payload::text ILIKE $2", [conversationId, `%${word}%`])).rows[0].n);
      cell.check("journal isolation: BLUEBIRD only in member 1's conversation, REDFOX only in member 2's", await leaked(c1, "BLUEBIRD") > 0 && await leaked(c1, "REDFOX") === 0 && await leaked(c2, "REDFOX") > 0 && await leaked(c2, "BLUEBIRD") === 0);
      const publicIds = [t1.runs[0]?.public_id, t2.runs[0]?.public_id];
      const mine = await chat.call("GET", `/v1/conversations${chat.q(productId)}`);
      const peek = await chat.call("GET", `/v1/conversations/${publicIds[0]}/history${chat.q(productId)}`);
      cell.check("the owner's own Chat listing and reads never expose the contacts' conversations", !(mine.json?.conversations ?? []).some((c) => publicIds.includes(c.id)) && peek.status >= 400, { listed: (mine.json?.conversations ?? []).length, peekStatus: peek.status });
      const refused = await outsider.say("Reply with exactly the word: intruder");
      await sleep(4000);
      const o = await trace(stack, "telegram", 6199);
      cell.check("a non-admitted sender is offered sign-in and starts no Run", refused.status === 200 && outsider.texts().length === 1 && /登录 Hatch，就能在这里和助理聊了/.test(outsider.texts()[0]) && o.runs.length === 0, { texts: outsider.texts(), runs: o.runs.length });
    });

    await walk(matrix, rec, "4c", "Telegram -> Chat, audience public: a Product's own bot answers anyone who writes to it", async (cell) => {
      const bot = await stack.productBot(owner, productId); cell.ids.connection = bot.connection;
      const stranger = new TgChat(stack, bot.hooks, 6201);
      const posted = await stranger.say("Reply with exactly the word: public-ok");
      await sleep(8000);
      const t = await trace(stack, "telegram", 6201);
      const answered = stranger.texts().some((text) => /public-ok/i.test(text));
      cell.ids.outcome = { status: posted.status, texts: stranger.texts(), runs: t.runs.length };
      cell.check("an unknown Telegram sender writing to a Product's own bot is met as a contact and answered, with no sign-up", answered && t.runs.length === 1, { texts: stranger.texts(), runs: t.runs.length, inbox: t.inbox });
    });

    await walk(matrix, rec, "4d", "Telegram login: a stranger on the shared bot is offered sign-in, and an invited guest reaches the Assistant only after signing in with their own id", async (cell) => {
      const studioOwner = await stack.account("tg-guest-owner");
      const api = new StudioApi(stack.url, Auth.bearer(studioOwner.apiKey));
      const stranger = new TgChat(stack, hooks, 6301);
      await stranger.say("hello");
      const [prompt] = await stranger.waitSends(1, 30_000);
      const link = prompt.body.reply_markup?.inline_keyboard?.[0]?.[0]?.url;
      cell.check("a stranger gets one button that opens our sign-in, not a refusal", /\/v1\/auth\/telegram\/start\?claim=/.test(link ?? "") && prompt.body.text === "登录 Hatch，就能在这里和助理聊了。", prompt.body);
      const group = new TgChat(stack, hooks, -6302, 6302);
      const before = stack.platform.sends().length;
      await group.say("hello", { chatType: "supergroup", mention: true });
      await sleep(1500);
      cell.check("in a group the same stranger gets silence", stack.platform.sends().length === before);
      const start = await fetch(`${stack.registryUrl}/v1/auth/telegram/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ claim: new URL(link).searchParams.get("claim") }) });
      const { authorize_url: authorizeUrl, state } = await start.json();
      cell.check("the Registry starts the code flow with PKCE", start.status === 200 && /code_challenge_method=S256/.test(authorizeUrl) && Boolean(state), { status: start.status });
      const back = stack.platform.authorize(authorizeUrl, { id: 6301, name: "Stranger Six", username: "six" });
      const finish = await fetch(`${stack.registryUrl}/v1/auth/telegram/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: back.code, state: back.state }) });
      const session = await finish.json();
      cell.check("the callback verifies the id_token and answers with a session for a new account", finish.status === 201 && session.created === true && Boolean(session.token), { status: finish.status, created: session.created });
      const greeted = await stranger.waitSends(2, 30_000);
      cell.check("the chat is bound and greeted in Telegram", /连上了/.test(greeted[1].body.text), greeted[1]?.body);
      const replay = await fetch(`${stack.registryUrl}/v1/auth/telegram/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: back.code, state: back.state }) });
      cell.check("the same callback again is refused", replay.status === 400, replay.status);

      const forged = stack.platform.authorize((await (await fetch(`${stack.registryUrl}/v1/auth/telegram/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).authorize_url, { id: 6310, name: "Forger", username: "f" });
      stack.platform.login.codes.get(forged.code).user = { id: 6310, name: "Forger", username: "f" };
      const noSignature = await fetch(`${stack.registryUrl}/v1/auth/telegram/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "never-issued", state: forged.state }) });
      cell.check("a code Telegram never issued signs nobody in", noSignature.status >= 400 && !(await stack.registryPool.query("SELECT 1 FROM account_identities WHERE subject = '6310'")).rowCount, noSignature.status);
    });
  }

  // ── Own-app platforms: Feishu and WeCom ──────────────────────────────

  async ownApps(stack, rec, matrix, hasKimi) {
    await Promise.all([this.feishu(stack, rec, matrix, hasKimi), this.wecom(stack, rec, matrix, hasKimi)]);
  }

  async feishu(stack, rec, matrix, hasKimi) {
    const account = await stack.account("feishu-owner");
    const studio = new StudioApi(stack.url, Auth.bearer(account.apiKey));
    const hooks = new FeishuWebhooks(stack.registryUrl, account.id);
    const platform = stack.platform;
    const forMessage = (messageId) => feishuSends(platform).filter((s) => s.path.includes(`/${messageId}/reply`));
    const idOf = (event) => event.event.message.message_id;
    const owner = "ou_feishu_owner";
    let linked = false;

    await walk(matrix, rec, "3e", "Feishu -> Studio: own-app credentials, signed+encrypted webhook, link code, the Assistant answers and a card button confirms a price change", async (cell) => {
      if (!hasKimi) cell.block("LLM_API_KEY (kimi-k2.6) is absent, the Studio Assistant cannot run");
      const posted = await studio.call("POST", "/v1/creator/connections/feishu/credentials", { body: FEISHU_CREDENTIALS });
      const view = posted.json?.channels?.find((c) => c.kind === "feishu");
      const probes = platform.calls.filter((c) => c.host === "open.feishu.cn").map((c) => c.path);
      cell.check("credentials accepted: probed the platform (tenant token, bot info) and the Connection is available with its own webhook URL", posted.status === 200 && view?.available && view?.own_app && (view?.webhook_url ?? "").endsWith(`/v1/channels/feishu/${account.id}/webhook`) && probes.includes("/open-apis/bot/v3/info"), { status: posted.status, view, probes });
      const bad = await hooks.post(hooks.message({ openId: owner, text: "x" }), { badSignature: true });
      const challenge = await hooks.post({ type: "url_verification", challenge: "verify-challenge", token: FEISHU_CREDENTIALS.verification_token });
      cell.check("a wrong signature is refused (401) and url_verification is echoed", bad.status === 401 && challenge.status === 200 && JSON.parse(challenge.text).challenge === "verify-challenge", { bad: bad.status, challenge });
      const code = (await studio.call("POST", "/v1/creator/connections/feishu/connect", { body: {} })).json?.code;
      const linkMessage = hooks.message({ openId: owner, text: code });
      const sent = await hooks.post(linkMessage);
      cell.check("the code message is accepted (signed, encrypted)", sent.status === 200, sent);
      await until("the connected reply", () => forMessage(idOf(linkMessage)).length >= 1, { timeoutMs: 30_000, everyMs: 200 });
      linked = true;
      const welcome = forMessage(idOf(linkMessage))[0];
      cell.ids.welcome = { path: welcome.path, text: welcome.text, authorization: welcome.authorization, uuid: welcome.uuid };
      cell.check("the adapter replied on the platform (reply API with the tenant token)", /连上了/.test(welcome.text) && welcome.authorization === "present", welcome);

      const priced = new PricedProduct(stack, studio, account); await priced.create("Matrix Feishu Product"); cell.ids.productId = priced.id;
      const known = new Set((await priced.tasks()).map((t) => t.id));
      await hooks.post(hooks.message({ openId: owner, text: proposeText(priced.id, PRICE.approved) }));
      const task = await priced.nextChange(known, PRICE.approved); cell.ids.approvedTask = task.id;
      const card = await until("an interactive card with buttons", () => feishuSends(platform).find((s) => s.buttons.some((b) => b.taskId === task.id)), { timeoutMs: 150_000, everyMs: 300 });
      cell.check("the pending task is sent as an interactive card with 确认 and 取消", card.msgType === "interactive" && card.buttons.map((b) => b.label).join() === "确认,取消" && card.buttons[0].action === "approve", card.buttons);
      cell.check("before the press the price is unchanged", PricedProduct.same((await priced.price()).pricing, PRICE.before));
      const press = await hooks.post(hooks.cardAction({ openId: owner, taskId: task.id, action: "approve" }));
      const done = await until("task done", async () => { const r = await priced.task(task.id); return r.status === "done" ? r : undefined; }, { timeoutMs: 30_000, everyMs: 300 }).catch(() => priced.task(task.id));
      cell.check("card.action.trigger approve: accepted, task confirmed, price changed", press.status === 200 && done.status === "done" && /已确认/.test(done.summary ?? "") && PricedProduct.same((await priced.price()).pricing, PRICE.approved), { press: press.status, status: done.status, price: price((await priced.price()).pricing) });
      const stranger = await hooks.post(hooks.cardAction({ openId: "ou_stranger", taskId: task.id, action: "decline" }));
      await sleep(2000);
      cell.check("a stranger's card action neither declines nor changes anything", stranger.status === 200 && PricedProduct.same((await priced.price()).pricing, PRICE.approved), { status: stranger.status });
    });

    await walk(matrix, rec, "4d", "Feishu -> Chat: org member answered, outsider refused, then a public Connection meets anyone as a contact", async (cell) => {
      if (!linked) {
        // Credentials are the precondition; 3e posts them. Without kimi 3e blocked before posting, so do it here.
        const posted = await studio.call("POST", "/v1/creator/connections/feishu/credentials", { body: FEISHU_CREDENTIALS });
        if (posted.status !== 200) cell.block(`Feishu credentials were not accepted: ${posted.status}`);
      }
      const productId = await stack.product(account, { system: SYSTEM }); cell.ids.productId = productId;
      const org = await stack.connection({ owner: account, channel: "feishu", audience: "org", productId, scope: account.id }); cell.ids.orgConnection = org;
      await stack.admit(org, { channel: "feishu", senderId: "ou_member", scope: account.id });
      const converse = async (openId, text) => { const message = hooks.message({ openId, text }); const posted = await hooks.post(message); await until(`reply to ${openId}`, () => forMessage(idOf(message)).length >= 1, { timeoutMs: 120_000, everyMs: 200 }); return { posted, id: idOf(message), sends: forMessage(idOf(message)), reply: forMessage(idOf(message))[0].text }; };
      const member = await converse("ou_member", "Reply with exactly the word: feishu-org-ok");
      cell.check("org member: one reply with the answer", member.posted.status === 200 && /feishu-org-ok/i.test(member.reply), member.reply);
      const outsider = await converse("ou_outsider", "Reply with exactly the word: intruder");
      cell.check("org outsider: refused with the connect notice (no Run)", /请先从 Hatch Studio 连接 飞书/.test(outsider.reply), outsider.reply);
      await sleep(6000);
      const tm = await trace(stack, "feishu", "ou_member"); const to = await trace(stack, "feishu", "ou_outsider");
      cell.check("member: one inbound -> one Run -> one reply row sent; outsider: no Run", tm.runs.length === 1 && tm.outbox.length === 1 && tm.outbox[0].state === "sent" && member.sends.length === 1 && to.runs.length === 0, { member: { runs: tm.runs.length, outbox: tm.outbox }, outsider: to.runs.length });
      cell.check("the Feishu principal is a contact, not the owner's account", tm.runs[0] && tm.runs[0].owner_account_id !== account.id, { conversationOwner: tm.runs[0]?.owner_account_id, owner: account.id });

      const pub = await stack.connection({ owner: account, channel: "feishu", audience: "public", productId, scope: account.id }); cell.ids.publicConnection = pub;
      const [p1, p2] = [await converse("ou_public_1", "My secret code word is MANGO. Reply with exactly the word: noted"), await converse("ou_public_2", "What secret code word did I tell you? If none, reply with exactly the word: none")];
      cell.check("public: two unknown senders are each met as contacts and answered", /noted/i.test(p1.reply) && /\w/.test(p2.reply), { p1: p1.reply, p2: p2.reply });
      cell.check("public: contacts are isolated (the second does not learn the first's word)", !/MANGO/i.test(p2.reply), p2.reply);
      await sleep(6000);
      const tp1 = await trace(stack, "feishu", "ou_public_1"); const tp2 = await trace(stack, "feishu", "ou_public_2");
      cell.check("public: one Run each, distinct conversations, contact principals", tp1.runs.length === 1 && tp2.runs.length === 1 && tp1.runs[0].conversation_id !== tp2.runs[0].conversation_id && tp1.runs[0].owner_account_id !== account.id, { c1: tp1.runs[0]?.conversation_id, c2: tp2.runs[0]?.conversation_id, owner: tp1.runs[0]?.owner_account_id });
      cell.ids.public = { p1: tp1.runs.map((r) => r.id), p2: tp2.runs.map((r) => r.id) };
    });
  }

  async wecom(stack, rec, matrix, hasKimi) {
    const account = await stack.account("wecom-owner");
    const studio = new StudioApi(stack.url, Auth.bearer(account.apiKey));
    const hooks = new WeComWebhooks(stack.registryUrl, account.id);
    const platform = stack.platform;
    const owner = "wm_owner";
    const replyTo = (responseUrl) => wecomSends(platform).filter((s) => s.path === new URL(responseUrl).pathname);
    const exchange = async (userId, text) => { const message = hooks.message({ userId, text }); const posted = await hooks.post(message); const url = message.response_url; await until(`reply on ${url}`, () => replyTo(url).length >= 1, { timeoutMs: 120_000, everyMs: 200 }); return { posted, message, replies: replyTo(url) }; };
    let ready = false;

    const prepare = async (cell) => {
      if (ready) return;
      const posted = await studio.call("POST", "/v1/creator/connections/wecom/credentials", { body: WECOM_CREDENTIALS });
      const view = posted.json?.channels?.find((c) => c.kind === "wecom");
      cell.check("WeCom credentials accepted (no probe exists for the smart bot): own-app Connection with its webhook URL", posted.status === 200 && view?.available && (view?.webhook_url ?? "").endsWith(`/v1/channels/wecom/${account.id}/webhook`), { status: posted.status, view });
      const verify = await hooks.verifyUrl();
      const bad = await hooks.post(hooks.message({ userId: owner, text: "x" }), { badSignature: true });
      cell.check("URL verification GET returns the decrypted echostr; a bad signature is refused (401)", verify.status === 200 && verify.text === verify.expected && bad.status === 401, { verify, bad: bad.status });
      ready = true;
    };

    await walk(matrix, rec, "3f", "WeCom -> Studio: own-app credentials, encrypted webhook, link code, the Assistant answers via response_url, a price change confirmed by text (no buttons on WeCom)", async (cell) => {
      if (!hasKimi) cell.block("LLM_API_KEY (kimi-k2.6) is absent, the Studio Assistant cannot run");
      await prepare(cell);
      const code = (await studio.call("POST", "/v1/creator/connections/wecom/connect", { body: {} })).json?.code;
      const link = await exchange(owner, code);
      cell.check("the code is accepted and answered once on that message's response_url (markdown)", link.posted.status === 200 && link.replies.length === 1 && link.replies[0].msgtype === "markdown" && /连上了/.test(link.replies[0].text), link.replies);
      const priced = new PricedProduct(stack, studio, account); await priced.create("Matrix WeCom Product"); cell.ids.productId = priced.id;
      const known = new Set((await priced.tasks()).map((t) => t.id));
      const proposed = hooks.message({ userId: owner, text: proposeText(priced.id, PRICE.approved) });
      await hooks.post(proposed);
      const task = await priced.nextChange(known, PRICE.approved); cell.ids.approvedTask = task.id;
      await until("the Assistant's reply", () => replyTo(proposed.response_url).length >= 1, { timeoutMs: 150_000, everyMs: 300 });
      const asked = replyTo(proposed.response_url)[0].text;
      cell.check("the pending-change reply degrades the buttons into a typed instruction 「确认」/「取消」", /「确认」/.test(asked) && /「取消」/.test(asked), asked.slice(-200));
      cell.check("before the confirmation the price is unchanged", PricedProduct.same((await priced.price()).pricing, PRICE.before));
      const confirmMessage = hooks.message({ userId: owner, text: `确认。请调用 approve_task 工具确认任务 ${task.id}。` });
      await hooks.post(confirmMessage);
      const done = await until("task done", async () => { const r = await priced.task(task.id); return r.status === "done" ? r : undefined; }, { timeoutMs: 120_000, everyMs: 500 }).catch(() => priced.task(task.id));
      cell.check("a typed confirmation in the chat (the Assistant's approve_task) applies the change", done.status === "done" && PricedProduct.same((await priced.price()).pricing, PRICE.approved), { status: done.status, price: price((await priced.price()).pricing) });
      await sleep(3000);
      cell.check("every WeCom inbound message got at most one reply (response_url allows one)", [link.message.response_url, proposed.response_url, confirmMessage.response_url].every((url) => replyTo(url).length <= 1), [link.message.response_url, proposed.response_url, confirmMessage.response_url].map((url) => replyTo(url).length));
    });

    await walk(matrix, rec, "4e", "WeCom -> Chat: org member answered once on response_url, outsider refused, then a public Connection meets anyone", async (cell) => {
      await prepare(cell);
      const productId = await stack.product(account, { system: SYSTEM }); cell.ids.productId = productId;
      const org = await stack.connection({ owner: account, channel: "wecom", audience: "org", productId, scope: account.id });
      await stack.admit(org, { channel: "wecom", senderId: "wm_member", scope: account.id });
      const member = await exchange("wm_member", "Reply with exactly the word: wecom-org-ok");
      cell.check("org member: one reply with the answer on the response_url", /wecom-org-ok/i.test(member.replies[0].text) && member.replies.length === 1, member.replies);
      const outsider = await exchange("wm_outsider", "Reply with exactly the word: intruder");
      cell.check("org outsider: refused with the connect notice", /请先从 Hatch Studio 连接 企业微信/.test(outsider.replies[0].text), outsider.replies);
      await sleep(6000);
      const tm = await trace(stack, "wecom", "wm_member"); const to = await trace(stack, "wecom", "wm_outsider");
      cell.check("member: one Run, one reply row sent, still exactly one reply; outsider: no Run", tm.runs.length === 1 && tm.outbox.length === 1 && replyTo(member.message.response_url).length === 1 && to.runs.length === 0, { runs: tm.runs.length, outbox: tm.outbox, outsiderRuns: to.runs.length });
      cell.check("the WeCom org principal is a contact", tm.runs[0] && tm.runs[0].owner_account_id !== account.id, tm.runs[0]?.owner_account_id);
      await stack.connection({ owner: account, channel: "wecom", audience: "public", productId, scope: account.id });
      const stranger = await exchange("wm_public", "Reply with exactly the word: wecom-public-ok");
      await sleep(5000);
      const tp = await trace(stack, "wecom", "wm_public");
      cell.check("public: an unknown sender is met as a contact and answered once", /wecom-public-ok/i.test(stranger.replies[0].text) && tp.runs.length === 1 && tp.runs[0].owner_account_id !== account.id, { reply: stranger.replies[0]?.text, runs: tp.runs.length });
    });
  }
}

export default new Matrix();
