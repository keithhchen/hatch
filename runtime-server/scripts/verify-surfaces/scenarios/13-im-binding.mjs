import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Scenario } from "../lib/scenario.mjs";
import { Auth, ChatApi, HatchCli, StudioApi } from "../lib/clients.mjs";
import { TelegramWebhooks } from "../lib/webhooks.mjs";
import { cliHome } from "../lib/matrix-helpers.mjs";
import { freePort, sleep, until } from "../lib/util.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const dashboardRoot = path.join(repoRoot, "creator-dashboard");
const PASSWORD = "Verify-Pass-123!";
const NOT_CONNECTED = /请先从 Hatch Studio 连接 Telegram/;
const system = (word) => `You are Product ${word}. Whatever the user writes, reply with exactly the single word: ${word}`;

/** A Telegram private chat with the shared bot, played through the fake platform. */
class TgChat {
  constructor(stack, hooks, chatId) { this.stack = stack; this.hooks = hooks; this.chatId = chatId; }
  say(text) { return this.hooks.post(this.hooks.message({ chatId: this.chatId, text })); }
  texts() { return this.stack.platform.sends().filter((call) => call.body.chat_id === this.chatId).map((call) => call.body.text); }
  async waitTexts(count, timeoutMs = 120_000) { await until(`${count} sends to chat ${this.chatId}`, () => this.texts().length >= count, { timeoutMs, everyMs: 200 }); return this.texts(); }
}

/** The real dashboard server and a headless browser on it: the page a non-technical user would use. */
async function openDashboard(stack) {
  const { startDashboardServer } = await import(pathToFileURL(path.join(dashboardRoot, "server.mjs")).href);
  const { chromium } = await import(pathToFileURL(path.join(dashboardRoot, "node_modules/playwright/index.mjs")).href);
  const port = await freePort();
  const scratch = mkdtempSync(path.join(os.tmpdir(), "hatch-verify-dashboard-"));
  const dashboard = await startDashboardServer({ host: "127.0.0.1", port, publicOrigin: `http://127.0.0.1:${port}`, registryUrl: stack.registryUrl, ledgerPath: path.join(scratch, "ledger.jsonl"), portalStatePath: path.join(scratch, "portal-state.json"), paymentMode: "disabled" });
  const browser = await chromium.launch({ ...(process.env.HATCH_VERIFY_CHROMIUM ? { executablePath: process.env.HATCH_VERIFY_CHROMIUM } : {}) }).catch(async (error) => { await new Promise((resolve) => dashboard.server.close(resolve)); throw error; });
  const page = await (await browser.newContext({ baseURL: `http://127.0.0.1:${port}` })).newPage();
  return { page, close: async () => { await browser.close(); await new Promise((resolve) => dashboard.server.close(resolve)); } };
}

class ImBinding extends Scenario {
  constructor() { super({ id: 13, title: "Telegram binding self-served from the dashboard page: Assistant (Studio) and per-Product Chat, with the 2x2 for one account" }); }

  async run(stack, rec) {
    const hasKimi = Boolean(process.env.LLM_API_KEY);
    rec.note("Real: the dashboard server and built page driven by headless Chromium (sign-in form, tile clicks), the Registry, Runtime, Chat and Assistant. Simulated: only the messaging platform (Telegram webhooks in, bot sends read from the fake platform). The second account binds through the same HTTP endpoints the page calls, not through a second browser. Products are created through the real create route and given a live release by test setup (the factory is not exercised).");
    if (!hasKimi) rec.note("LLM_API_KEY is absent: the Studio Assistant cannot answer, so Assistant replies are BLOCKED (binding and routing are still checked).");
    const owner = await stack.account("page-owner");
    const other = await stack.account("page-other");
    const studio = new StudioApi(stack.url, Auth.bearer(owner.apiKey));
    const otherStudio = new StudioApi(stack.url, Auth.bearer(other.apiKey));
    const product = async (account, api, word) => {
      const id = (await api.call("POST", "/v1/creator/products", { body: { name: `Product ${word}`, promise: `${word}: verification product` } })).json?.product?.product_id;
      if (!id) throw new Error("product create failed");
      await stack.product(account, { productId: id, name: `Product ${word}`, system: system(word) });
      return id;
    };
    const [alpha, bravo, charlie] = [await product(owner, studio, "ALPHA"), await product(owner, studio, "BRAVO"), await product(other, otherStudio, "CHARLIE")];
    const hooks = new TelegramWebhooks(stack.registryUrl);
    const assistantChat = new TgChat(stack, hooks, 7101); const alphaChat = new TgChat(stack, hooks, 7102); const bravoChat = new TgChat(stack, hooks, 7103);
    const otherChat = new TgChat(stack, hooks, 7201); const stranger = new TgChat(stack, hooks, 9999);
    const runsOf = async (senderId) => {
      const ids = (await stack.registryPool.query("SELECT run_id FROM hatch_channel_inbox WHERE channel = 'telegram' AND sender_id = $1 AND run_id IS NOT NULL", [String(senderId)])).rows.map((row) => row.run_id);
      return ids.length ? (await stack.runtimePool.query("SELECT r.id, r.status, c.owner_account_id, c.product_id FROM hatch_conversation_runs r JOIN hatch_conversations c ON c.id = r.conversation_id WHERE r.id = ANY($1)", [ids])).rows : [];
    };
    const dash = await openDashboard(stack);
    try {
      const { page } = dash;
      // ── The page: sign in as a user would ──
      await page.goto("/sign-in?returnTo=%2Fstudio%2Fassistant");
      await page.getByLabel("Email").fill(owner.email);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL(/\/studio\/assistant/);
      const tile = (state) => page.locator(`.cb-tile[data-channel="telegram"]${state ? `[data-state="${state}"]` : ""}`);
      const bindFromPage = async (route, chat, label) => {
        await page.goto(route);
        await tile("unbound").waitFor({ timeout: 30_000 }).catch(async (error) => {
          const probe = await page.evaluate(() => fetch("/v1/creator/connections", { credentials: "same-origin" }).then(async (r) => `${r.status} ${(await r.text()).slice(0, 300)}`));
          throw new Error(`${error.message.split("\n")[0]} | url ${page.url()} | api ${probe} | page ${(await page.locator("body").innerText()).slice(0, 300)}`);
        });
        rec.check(`${label}: before binding the page shows an unbound Telegram tile`, await tile("unbound").count() === 1);
        const text = await tile().innerText();
        rec.check(`${label}: the tile carries a name and no description`, text.trim() === "Telegram", text);
        await tile("unbound").click();
        await tile("waiting").waitFor({ timeout: 15_000 });
        const href = await tile("waiting").getAttribute("href");
        const code = href?.match(/start=(HATCH-[A-Z0-9]{8})/)?.[1];
        rec.check(`${label}: one click gives the bot's t.me deep link carrying a one-time code`, Boolean(code) && href.startsWith("https://t.me/hatch_verify_bot?start="), href);
        // The user taps the link in Telegram: Telegram sends the bot `/start <code>`.
        const sentBefore = chat.texts().length;
        await chat.say(`/start ${code}`);
        // No reload: the page notices on its own.
        await tile("bound").waitFor({ timeout: 20_000 });
        rec.check(`${label}: the page shows the bound state by itself, naming who is bound`, (await page.locator(".cb-who").innerText()) === String(chat.chatId), await page.locator(".cb-who").innerText());
        rec.check(`${label}: the bot confirmed in Telegram`, (await chat.waitTexts(sentBefore + 1, 30_000)).length === sentBefore + 1);
        return code;
      };

      // ── Studio: the Assistant ──
      const assistantCode = await bindFromPage("/studio/assistant", assistantChat, "Assistant");
      const rows = (await stack.registryPool.query("SELECT c.audience, c.target_key, i.sender_id FROM hatch_connections c JOIN hatch_channel_identities i ON i.connection_id = c.id WHERE c.owner_account_id = $1", [owner.id])).rows;
      rec.check("the Assistant binding is the account's self Connection to the Assistant", rows.length === 1 && rows[0].audience === "self" && rows[0].target_key === "assistant" && rows[0].sender_id === "7101", rows);
      rec.note(`Assistant link code ${assistantCode} was one-time.`);
      let assistantAnswered = false;
      if (hasKimi) {
        const before = assistantChat.texts().length;
        await assistantChat.say("Say hello in one short sentence.");
        await assistantChat.waitTexts(before + 1, 150_000);
        assistantAnswered = true;
        const tasks = await stack.registryPool.query("SELECT count(*)::int AS n FROM hatch_assistant_tasks WHERE account_id = $1", [owner.id]);
        rec.check("Studio via Telegram: the Assistant answered the bound chat", assistantAnswered && assistantChat.texts().length > before, assistantChat.texts().slice(before));
        rec.measure("assistant_tasks_after_hello", tasks.rows[0].n);
      } else rec.check("Studio via Telegram: the Assistant answers the bound chat (BLOCKED: no LLM_API_KEY)", true, "blocked, not verified");

      // ── Chat: each Product bound from its own page ──
      await bindFromPage(`/studio/products/${alpha}/publish`, alphaChat, "Product ALPHA");
      await bindFromPage(`/studio/products/${bravo}/publish`, bravoChat, "Product BRAVO");
      await alphaChat.say("hello"); await bravoChat.say("hello");
      const alphaReply = (await alphaChat.waitTexts(2, 150_000))[1]; const bravoReply = (await bravoChat.waitTexts(2, 150_000))[1];
      rec.check("Chat via Telegram: the chat bound to ALPHA is answered by ALPHA", /ALPHA/.test(alphaReply) && !/BRAVO/.test(alphaReply), alphaReply);
      rec.check("Chat via Telegram: the chat bound to BRAVO is answered by BRAVO", /BRAVO/.test(bravoReply) && !/ALPHA/.test(bravoReply), bravoReply);
      await sleep(3000);
      const [alphaRuns, bravoRuns] = [await runsOf(7102), await runsOf(7103)];
      rec.check("each message started one Run, as the account (not a contact), on the right Product", alphaRuns.length === 1 && alphaRuns[0].product_id === alpha && alphaRuns[0].owner_account_id === owner.id && bravoRuns.length === 1 && bravoRuns[0].product_id === bravo && bravoRuns[0].owner_account_id === owner.id, { alphaRuns, bravoRuns });
      await page.goto(`/studio/products/${alpha}/publish`);
      await tile("bound").waitFor({ timeout: 30_000 });
      rec.check("ALPHA's page shows its own binding, and the Assistant's and BRAVO's bindings do not leak onto it", (await page.locator(".cb-who").innerText()) === "7102");

      // ── Coding agent row: the same account through the CLI ──
      const cli = new HatchCli({ apiUrl: stack.url, apiKey: owner.apiKey, home: cliHome(stack, "binding-cli") });
      const run = (...args) => cli.run(args).done;
      const chat = new ChatApi(stack.url, Auth.bearer(owner.apiKey));
      const cid = await chat.create(alpha, randomUUID(), []);
      const asked = await run("ask", "hello", "--product", alpha, "--conversation", cid, "--wait=60");
      rec.check("Chat via coding agent (hatch CLI): the same Product answers", asked.code === 0 && /ALPHA/.test(asked.json?.reply?.text ?? ""), { code: asked.code, reply: asked.json?.reply?.text });
      if (hasKimi) {
        const said = await run("assistant", "Say hello in one short sentence.", "--wait=120");
        rec.check("Studio via coding agent (hatch CLI): the Assistant answers", said.code === 0, { code: said.code, stderr: said.stderr.slice(0, 200) });
      } else rec.check("Studio via coding agent (hatch CLI): the Assistant answers (BLOCKED: no LLM_API_KEY)", true, "blocked, not verified");

      // ── A second account ──
      const foreign = await otherStudio.call("POST", "/v1/creator/connections/telegram/connect", { body: { product_id: alpha } });
      rec.check("another account cannot bind a chat to a Product it does not own (404)", foreign.status === 404, { status: foreign.status, body: foreign.text.slice(0, 120) });
      const view = await otherStudio.call("GET", `/v1/creator/connections?product_id=${alpha}`);
      rec.check("another account sees ALPHA as unbound", view.status === 200 && view.json.channels.find((c) => c.kind === "telegram")?.linked === false, view.json);
      const mine = await otherStudio.call("POST", "/v1/creator/connections/telegram/connect", { body: { product_id: charlie } });
      await otherChat.say(`/start ${mine.json?.code}`);
      await otherChat.waitTexts(1, 30_000);
      await otherChat.say("hello");
      const charlieReply = (await otherChat.waitTexts(2, 150_000))[1];
      rec.check("the second account's own binding reaches its own Product, as itself", /CHARLIE/.test(charlieReply) && (await runsOf(7201)).every((r) => r.owner_account_id === other.id && r.product_id === charlie), charlieReply);
      const ownerView = await studio.call("GET", `/v1/creator/connections?product_id=${charlie}`);
      rec.check("the owner cannot see or use the other account's binding", ownerView.json?.channels?.find((c) => c.kind === "telegram")?.linked === false);
      await stranger.say("hello");
      await stranger.waitTexts(1, 30_000);
      rec.check("an unbound Telegram user is told to connect from Studio and starts no Run", NOT_CONNECTED.test(stranger.texts()[0]) && (await runsOf(9999)).length === 0, stranger.texts());

      // ── Unbind from the page ──
      await page.goto(`/studio/products/${alpha}/publish`);
      await tile("bound").waitFor({ timeout: 30_000 });
      await page.locator(".cb-unbind").click();
      await tile("unbound").waitFor({ timeout: 15_000 });
      rec.check("unbinding from the page returns the tile to unbound", await tile("unbound").count() === 1);
      const sentBefore = alphaChat.texts().length;
      await alphaChat.say("hello again");
      await alphaChat.waitTexts(sentBefore + 1, 30_000);
      await sleep(2000);
      rec.check("after unbinding, the chat is told to connect and no Run starts", NOT_CONNECTED.test(alphaChat.texts()[sentBefore]) && (await runsOf(7102)).length === 1, alphaChat.texts().slice(sentBefore));
      const bravoBefore = bravoChat.texts().length;
      await bravoChat.say("still there?");
      await bravoChat.waitTexts(bravoBefore + 1, 150_000);
      rec.check("unbinding ALPHA left BRAVO bound and answering", /BRAVO/.test(bravoChat.texts()[bravoBefore]), bravoChat.texts().slice(bravoBefore));
      await page.goto("/studio/assistant");
      await tile("bound").waitFor({ timeout: 30_000 });
      await page.locator(".cb-unbind").click();
      await tile("unbound").waitFor({ timeout: 15_000 });
      const assistantBefore = assistantChat.texts().length;
      await assistantChat.say("anyone there?");
      await assistantChat.waitTexts(assistantBefore + 1, 30_000);
      rec.check("after unbinding the Assistant, its chat is told to connect", NOT_CONNECTED.test(assistantChat.texts()[assistantBefore]), assistantChat.texts().slice(assistantBefore));
      const count = (await stack.registryPool.query("SELECT count(*)::int AS n FROM hatch_channel_identities i JOIN hatch_connections c ON c.id = i.connection_id WHERE c.owner_account_id = $1", [owner.id])).rows[0].n;
      rec.check("only BRAVO remains bound for the account", count === 1, count);
    } finally { await dash.close().catch(() => undefined); }
  }
}

export default new ImBinding();
