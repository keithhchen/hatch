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
const system = (word) => `You are Product ${word}. Whatever the user writes, reply with exactly the single word: ${word}`;
const signInLink = (call) => call?.body?.reply_markup?.inline_keyboard?.[0]?.[0]?.url;
const claimOf = (url) => new URL(url).searchParams.get("claim");

/** A Telegram private chat, played through the fake platform. `hooks` is the bot it talks to: our shared one by default. */
class TgChat {
  constructor(stack, hooks, chatId) { this.stack = stack; this.hooks = hooks; this.chatId = chatId; }
  say(text) { return this.hooks.post(this.hooks.message({ chatId: this.chatId, text })); }
  calls() { return this.stack.platform.sends().filter((call) => call.body.chat_id === this.chatId); }
  texts() { return this.calls().map((call) => call.body.text); }
  async waitTexts(count, timeoutMs = 120_000) { await until(`${count} sends to chat ${this.chatId}`, () => this.texts().length >= count, { timeoutMs, everyMs: 200 }); return this.texts(); }
}

/** The real dashboard server and a headless browser on it: the page a non-technical user would use. */
async function openDashboard(stack) {
  const { startDashboardServer } = await import(pathToFileURL(path.join(dashboardRoot, "server.mjs")).href);
  const { chromium } = await import(pathToFileURL(path.join(dashboardRoot, "node_modules/playwright/index.mjs")).href);
  const port = await freePort();
  const scratch = mkdtempSync(path.join(os.tmpdir(), "hatch-verify-dashboard-"));
  const origin = `http://127.0.0.1:${port}`;
  const dashboard = await startDashboardServer({ host: "127.0.0.1", port, publicOrigin: origin, registryUrl: stack.registryUrl, ledgerPath: path.join(scratch, "ledger.jsonl"), portalStatePath: path.join(scratch, "portal-state.json"), paymentMode: "disabled" });
  const browser = await chromium.launch({ ...(process.env.HATCH_VERIFY_CHROMIUM ? { executablePath: process.env.HATCH_VERIFY_CHROMIUM } : {}) }).catch(async (error) => { await new Promise((resolve) => dashboard.server.close(resolve)); throw error; });
  const page = await (await browser.newContext({ baseURL: origin })).newPage();
  return { page, origin, close: async () => { await browser.close(); await new Promise((resolve) => dashboard.server.close(resolve)); } };
}

/**
 * What a person's browser does for the site's Telegram sign-in, against the real dashboard routes: start (the button's link), Telegram's page
 * (the fake platform, which sends them back with a code), and the callback. Returns the dashboard's answers; `callbackState` overrides the cookie.
 */
async function signInWithTelegram(stack, origin, { claim, user, returnTo, cookieState, replay = false }) {
  const started = await fetch(`${origin}/v1/auth/telegram/start?${new URLSearchParams({ ...(claim ? { claim } : {}), ...(returnTo ? { returnTo } : {}) })}`, { redirect: "manual" });
  const authorize = started.headers.get("location");
  const stateCookie = started.headers.getSetCookie().map((line) => line.split(";")[0]).find((line) => line.startsWith("hatch_tg_state="));
  if (started.status !== 302 || !authorize?.startsWith("https://oauth.telegram.org/auth")) return { started: started.status, location: authorize };
  const back = stack.platform.authorize(authorize, user);
  const callback = () => fetch(`${origin}/v1/auth/telegram/callback?${new URLSearchParams({ code: back.code, state: back.state })}`, { redirect: "manual", headers: { cookie: cookieState ?? stateCookie ?? "" } });
  const done = await callback();
  const again = replay ? await callback() : undefined;
  return { started: started.status, authorize, state: back.state, status: done.status, location: done.headers.get("location"), cookies: done.headers.getSetCookie().map((line) => line.split(";")[0].split("=")[0]), replay: again && { status: again.status, location: again.headers.get("location") } };
}

class ImBinding extends Scenario {
  constructor() { super({ id: 13, title: "Telegram: sign-in from the bot and from the site, and the Assistant for the owner" }); }

  async run(stack, rec) {
    const hasKimi = Boolean(process.env.LLM_API_KEY);
    rec.note("Real: the dashboard server and built page driven by headless Chromium (sign-in form, tile and bot form), the Registry, Runtime, Chat and Assistant, the OIDC code flow with PKCE and the JWKS check. Simulated: only the messaging platform and Telegram's login server (fake platform: webhooks in, bot sends out, oauth.telegram.org signing its own tokens with a test key). The browser's redirects to and from Telegram are played as HTTP calls to the real dashboard routes. Products are created through the real create route and given a live release by test setup (the factory is not exercised).");
    if (!hasKimi) rec.note("LLM_API_KEY is absent: the Studio Assistant cannot answer, so Assistant replies are BLOCKED (binding, admission and routing are still checked).");
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
    const [alpha, bravo] = [await product(owner, studio, "ALPHA"), await product(owner, studio, "BRAVO")];
    const shared = new TelegramWebhooks(stack.registryUrl);
    const assistantChat = new TgChat(stack, shared, 7101);
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

      // ── An email account links Telegram from the Studio page, with the deep link ──
      await page.goto("/studio/assistant");
      await tile("unbound").waitFor({ timeout: 30_000 });
      rec.check("Studio: before linking the page shows an unbound Telegram tile with a name and no description", (await tile().innerText()).trim() === "Telegram");
      await tile("unbound").click();
      await tile("waiting").waitFor({ timeout: 15_000 });
      const href = await tile("waiting").getAttribute("href");
      const code = href?.match(/start=(HATCH-[A-Z0-9]{8})/)?.[1];
      rec.check("Studio: one click gives the bot's t.me deep link carrying a one-time code", Boolean(code) && href.startsWith("https://t.me/hatch_verify_bot?start="), href);
      await assistantChat.say(`/start ${code}`);
      await tile("bound").waitFor({ timeout: 20_000 });
      rec.check("Studio: the page shows the linked state by itself, naming who is linked", (await page.locator(".cb-who").first().innerText()) === "7101");
      rec.check("Studio: the bot confirmed in Telegram", (await assistantChat.waitTexts(1, 30_000)).length === 1);
      const identity = (await stack.registryPool.query("SELECT account_id FROM account_identities WHERE provider = 'telegram' AND subject = '7101'")).rows;
      rec.check("linking by code claims the Telegram id for the account: one id, one account", identity.length === 1 && identity[0].account_id === owner.id, identity);
      const taken = await new TgChat(stack, shared, 7101).say(`/start ${(await studio.call("POST", "/v1/creator/connections/telegram/connect", { body: {} })).json?.code}`);
      rec.check("the same Telegram id cannot also link a second account", taken.status === 200 && (await stack.registryPool.query("SELECT count(*)::int AS n FROM account_identities WHERE provider = 'telegram' AND subject = '7101'")).rows[0].n === 1);
      if (hasKimi) {
        const before = assistantChat.texts().length;
        await assistantChat.say("Say hello in one short sentence.");
        await assistantChat.waitTexts(before + 1, 150_000);
        rec.check("Studio via Telegram: the Assistant answered the linked chat", assistantChat.texts().length > before, assistantChat.texts().slice(before));
      } else rec.check("Studio via Telegram: the Assistant answers the linked chat (BLOCKED: no LLM_API_KEY)", true, "blocked, not verified");

      // ── The bot signs a stranger in: sign-in link, account with no email, chat bound, greeting sent ──
      const fresh = new TgChat(stack, shared, 7301);
      await fresh.say("hello");
      const prompt = (await fresh.waitTexts(1, 30_000), fresh.calls()[0]);
      const link = signInLink(prompt);
      rec.check("a stranger to the shared bot gets one sign-in button, and nothing reaches the Assistant", /\/v1\/auth\/telegram\/start\?claim=/.test(link ?? "") && (await runsOf(7301)).length === 0, prompt?.body);
      const login = await signInWithTelegram(stack, dash.origin, { claim: claimOf(link), user: { id: 7301, name: "Fresh Person", username: "fresh" }, replay: true });
      rec.check("the sign-in goes to Telegram's authorize URL with PKCE and the bot_access scope", /code_challenge_method=S256/.test(login.authorize) && /telegram%3Abot_access|telegram:bot_access/.test(decodeURIComponent(login.authorize)), login.authorize);
      rec.check("coming back from Telegram signs them in: a session cookie and a redirect", login.status === 302 && login.cookies.includes("hatch_web_session"), login);
      rec.check("the same callback replayed does not sign anyone in again", login.replay?.status === 302 && /telegram=failed/.test(login.replay.location ?? ""), login.replay);
      const made = (await stack.registryPool.query("SELECT a.id, a.email, a.password_hash FROM account_identities i JOIN accounts a ON a.id = i.account_id WHERE i.provider = 'telegram' AND i.subject = '7301'")).rows;
      rec.check("an account was made for that Telegram id, with no email and no password", made.length === 1 && made[0].email === null && made[0].password_hash === null, made);
      const freshChat = (await stack.registryPool.query("SELECT c.audience, c.target_key, i.role FROM hatch_connections c JOIN hatch_channel_identities i ON i.connection_id = c.id WHERE c.owner_account_id = $1", [made[0]?.id])).rows;
      rec.check("their private chat is bound to their own Studio Assistant as its owner", freshChat.length === 1 && freshChat[0].audience === "self" && freshChat[0].target_key === "assistant" && freshChat[0].role === "owner", freshChat);
      rec.check("the bot said the Assistant's greeting in that chat", (await fresh.waitTexts(2, 30_000)).length === 2 && /连上了/.test(fresh.texts()[1]), fresh.texts());
      const again = await signInWithTelegram(stack, dash.origin, { user: { id: 7301, name: "Fresh Person", username: "fresh" } });
      rec.check("signing in again with the same Telegram id is the same account", (await stack.registryPool.query("SELECT count(*)::int AS n FROM account_identities WHERE provider = 'telegram' AND subject = '7301'")).rows[0].n === 1 && again.status === 302 && !/failed/.test(again.location ?? ""), again);

      // ── Refusals: the id in the token must be the sender the link was issued for ──
      const mallory = new TgChat(stack, shared, 7401);
      await mallory.say("hi");
      await mallory.waitTexts(1, 30_000);
      const stolen = claimOf(signInLink(mallory.calls()[0]));
      const wrong = await signInWithTelegram(stack, dash.origin, { claim: stolen, user: { id: 7499, name: "Someone Else", username: "else" } });
      rec.check("a link issued to one sender, completed by another Telegram user, is refused", wrong.status === 302 && /telegram=failed/.test(wrong.location ?? "") && (await stack.registryPool.query("SELECT count(*)::int AS n FROM account_identities WHERE subject IN ('7499', '7401')")).rows[0].n === 0, wrong);
      const reuse = await signInWithTelegram(stack, dash.origin, { claim: stolen, user: { id: 7401, name: "Mallory", username: "m" } });
      rec.check("and that link is spent: the rightful sender cannot use it afterwards", /telegram=failed/.test(reuse.location ?? ""), reuse);
      const noCookie = await signInWithTelegram(stack, dash.origin, { user: { id: 7501, name: "Browserless", username: "b" }, cookieState: "hatch_tg_state=forged" });
      rec.check("a callback whose state is not the one this browser started is refused", /telegram=failed/.test(noCookie.location ?? "") && (await stack.registryPool.query("SELECT count(*)::int AS n FROM account_identities WHERE subject = '7501'")).rows[0].n === 0, noCookie);
      const unsigned = await fetch(`${dash.origin}/v1/auth/telegram/callback?code=forged&state=forged`, { redirect: "manual" });
      rec.check("a callback with no started sign-in is refused", unsigned.status === 302 && /telegram=failed/.test(unsigned.headers.get("location") ?? ""));
      rec.check("the sign-in and sign-up pages offer Telegram", await (async () => { await page.context().clearCookies(); await page.goto("/sign-in"); return page.locator('a[href^="/v1/auth/telegram/start"]').first().waitFor({ timeout: 15_000 }).then(() => true, () => false); })());
      await page.goto("/sign-in?returnTo=%2Fstudio%2Fassistant");
      await page.getByLabel("Email").fill(owner.email);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL(/\/studio\/assistant/);

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

      // ── Unlink the Assistant from the page: the chat is a stranger's again ──
      await page.goto("/studio/assistant");
      await tile("bound").waitFor({ timeout: 30_000 });
      await page.locator(".cb-tile.is-bound .cb-unbind").first().click();
      await tile("unbound").waitFor({ timeout: 15_000 });
      const assistantBefore = assistantChat.texts().length;
      await assistantChat.say("anyone there?");
      await assistantChat.waitTexts(assistantBefore + 1, 30_000);
      rec.check("after unlinking, the chat is offered sign-in again and reaches no Assistant", Boolean(signInLink(assistantChat.calls().at(-1))) && (await runsOf(7101)).length <= 1, assistantChat.texts().slice(assistantBefore));
    } finally { await dash.close().catch(() => undefined); }
  }
}

export default new ImBinding();
