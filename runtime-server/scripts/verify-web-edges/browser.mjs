import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "../../../creator-dashboard/node_modules/playwright-core/index.mjs";
import { ChatApi, Auth } from "../verify-surfaces/lib/clients.mjs";
import { sleep, until } from "../verify-surfaces/lib/util.mjs";

export const STORY = "Write a 200 word story about a lighthouse keeper. Plain prose only: no markdown, no headings, no lists. Do not stop early.";
export const SHORT = (word) => `Reply with exactly the single word: ${word}`;
/** Letters and digits only, so markdown rendering and whitespace never decide a comparison. */
export const norm = (text) => String(text ?? "").replace(/[^\p{L}\p{N}]/gu, "");

/** Playwright's own revision when installed; otherwise CHROMIUM, or any cached headless shell (the cache may hold another revision). */
export const launch = () => {
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  const cached = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().map((d) => path.join(cache, d, "chrome-headless-shell-mac-arm64/chrome-headless-shell")).find(existsSync) : undefined;
  return chromium.launch({ executablePath: process.env.CHROMIUM || (existsSync(chromium.executablePath()) ? undefined : cached) });
};

/** Everything one browser sees: console, page errors, failed and 4xx/5xx requests, WebSocket frames, and every alert the UI ever showed. */
export class Watch {
  constructor(label) { this.label = label; this.t0 = Date.now(); this.console = []; this.pageErrors = []; this.failed = []; this.http = []; this.frames = []; this.alerts = []; this.sockets = 0; this.requests = []; }
  at() { return Date.now() - this.t0; }

  async attach(page) {
    page.on("console", (m) => { if (["error", "warning"].includes(m.type())) this.console.push({ at: this.at(), type: m.type(), text: m.text().slice(0, 400) }); });
    page.on("pageerror", (e) => this.pageErrors.push({ at: this.at(), text: String(e.message ?? e).slice(0, 400) }));
    page.on("requestfailed", (r) => this.failed.push({ at: this.at(), method: r.method(), url: r.url().replace(/^https?:\/\/[^/]+/, ""), error: r.failure()?.errorText }));
    page.on("response", (r) => { if (r.url().includes("/v1/")) this.requests.push(`${this.at()} ${r.request().method()} ${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, "").replace(/\?.*/, "")}`); if (r.status() >= 400) this.http.push({ at: this.at(), method: r.request().method(), status: r.status(), url: r.url().replace(/^https?:\/\/[^/]+/, "") }); });
    page.on("websocket", (ws) => {
      const socket = ++this.sockets;
      const note = (dir) => (f) => {
        let type = "?"; let extra = {};
        try { const j = JSON.parse(String(f.payload)); type = j.type; if (j.code) extra.code = j.code; if (j.error?.code) extra.code = j.error.code; if (j.status) extra.status = j.status; if (j.run_id) extra.run = j.run_id.slice(-6); } catch { /* not JSON */ }
        this.frames.push({ at: this.at(), socket, dir, type, ...extra });
      };
      this.frames.push({ at: this.at(), socket, dir: "open", type: "ws.open" });
      ws.on("framesent", note("->")); ws.on("framereceived", note("<-"));
      ws.on("close", () => this.frames.push({ at: this.at(), socket, dir: "close", type: "ws.close" }));
      ws.on("socketerror", (e) => this.frames.push({ at: this.at(), socket, dir: "error", type: "ws.error", extra: String(e) }));
    });
    await page.exposeFunction("__recordAlert", (text) => this.alerts.push({ at: this.at(), text }));
    await page.addInitScript(() => {
      const seen = new Set();
      const scan = () => document.querySelectorAll('[role="alert"], .web-chat__notice').forEach((el) => {
        const text = el.innerText.trim();
        if (text && !seen.has(text)) { seen.add(text); window.__recordAlert(text); }
      });
      new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true });
    });
  }

  async waitFrame(type, { timeout = 90_000, since = 0 } = {}) {
    const from = this.frames.length - since;
    await until(`a ${type} frame`, () => this.frames.slice(Math.max(0, from)).some((f) => f.dir === "<-" && f.type === type), { timeoutMs: timeout, everyMs: 50 });
  }
  count(type, dir = "<-") { return this.frames.filter((f) => f.type === type && f.dir === dir).length; }
}

/** One signed-in browser context (cookies shared by its pages) on the real Dashboard. */
export class Client {
  static async open(web, browser, world, { label = "tab", conversationId, reuse, beforeGoto, noConversation } = {}) {
    const context = reuse ? reuse.context : await browser.newContext({ locale: "en-US", viewport: { width: 1100, height: 800 } });
    const client = new Client(web, context, world, label);
    client.page = await client.newPage();
    if (!reuse) {
      await client.page.goto(`${web.url}/`);
      const signedIn = await client.page.evaluate(async (email) => (await fetch("/v1/auth/sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "Verify-Pass-123!" }) })).status, world.owner.email);
      if (signedIn !== 200) throw new Error(`browser sign-in failed: ${signedIn}`);
    }
    if (beforeGoto) await beforeGoto(client.page);
    if (conversationId) await client.goto(conversationId, client.page, { socket: !beforeGoto });
    else if (!noConversation) await client.startConversation();
    return client;
  }

  constructor(web, context, world, label) { this.web = web; this.context = context; this.world = world; this.label = label; this.watch = new Watch(label); }
  async newPage() { const page = await this.context.newPage(); await this.watch.attach(page); return page; }
  get url() { return `${this.web.url}/chat/product/${this.world.productId}${this.conversationId ? `/conversation/${this.conversationId}` : ""}`; }

  /** The real "Start conversation" button, then wait for the composer to be usable. */
  async startConversation() {
    await this.page.goto(`${this.web.url}/chat/product/${this.world.productId}`);
    await this.page.getByRole("button", { name: /start conversation/i }).first().click();
    await this.page.waitForURL(/\/conversation\//);
    this.conversationId = this.page.url().split("/").pop();
    await this.ready();
  }
  async goto(conversationId, page = this.page, { socket = true } = {}) { this.conversationId = conversationId; await page.goto(this.url); await this.ready(page, { socket }); }
  async ready(page = this.page, { socket = true } = {}) { await page.locator(".web-chat__composer textarea").waitFor({ timeout: 30_000 }); if (socket) await this.watch.waitFrame("session.ready", { timeout: 30_000 }).catch(() => undefined); }

  composer(page = this.page) { return page.locator(".web-chat__composer textarea"); }
  async send(text, page = this.page) { await this.composer(page).fill(text); await page.locator(".web-chat__send").click(); }

  /** The conversation as this tab shows it. */
  async messages(page = this.page) {
    return page.locator(".web-chat__message").evaluateAll((els) => els.map((e) => ({
      role: e.classList.contains("web-chat__message--user") ? "user" : "assistant",
      state: [...e.classList].filter((c) => /^web-chat__message--/.test(c) && !/--(user|assistant)$/.test(c)).map((c) => c.replace("web-chat__message--", "")).join(","),
      text: [...e.querySelectorAll(".web-chat__content")].map((n) => n.innerText).join("\n").trim(),
      typing: Boolean(e.querySelector(".web-chat__typing"))
    })));
  }
  async visibleAlerts(page = this.page) { return page.locator('[role="alert"], .web-chat__notice').allInnerTexts(); }
  async bodyText(page = this.page) { return (await page.locator("body").innerText()).slice(0, 600); }
  async busy(page = this.page) { return (await page.locator(".web-chat__stop, .web-chat__typing").count()) > 0; }

  /** Quiet for `quietMs`, and (when given) the Runtime reports no run in flight. */
  async settle({ quietMs = 2500, timeout = 150_000, page = this.page, api } = {}) {
    const deadline = Date.now() + timeout;
    let quietSince;
    while (Date.now() < deadline) {
      const idle = !(await this.busy(page)) && (!api || (await api.inFlight()) === 0);
      if (idle) { quietSince ??= Date.now(); if (Date.now() - quietSince >= quietMs) return true; } else quietSince = undefined;
      await sleep(250);
    }
    return false;
  }

  async shot(file, page = this.page) { await page.screenshot({ path: file }).catch(() => undefined); }
  async close() { await this.context.close().catch(() => undefined); }
}

/** A fresh owner, Product and the Runtime's own record of it (the truth the UI is compared against). */
export class World {
  static async create(web, label) {
    const owner = await web.stack.account(label);
    const productId = await web.stack.ownedProduct(owner);
    return new World(web, owner, productId);
  }
  constructor(web, owner, productId) { this.web = web; this.owner = owner; this.productId = productId; this.chat = new ChatApi(web.stack.url, Auth.bearer(owner.apiKey)); }

  async runs(conversationId) { return (await this.chat.runs(conversationId, this.productId)).json?.runs ?? []; }
  async inFlight(conversationId) { return (await this.runs(conversationId)).filter((r) => !["completed", "failed", "cancelled", "interrupted"].includes(r.status)).length; }
  async messages(conversationId) { return (await this.chat.messages(conversationId, this.productId)).map((m) => ({ role: m.role, text: m.content })); }
  /** Account-bound client view of in-flight runs for one conversation. */
  forConversation(conversationId) { return { inFlight: () => this.inFlight(conversationId) }; }
}
