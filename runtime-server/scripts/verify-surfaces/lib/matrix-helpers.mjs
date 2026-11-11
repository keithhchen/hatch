import { spawn } from "node:child_process";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Blocked } from "./scenario.mjs";
import { CLI_BIN } from "./clients.mjs";
import { sleep, until } from "./util.mjs";

/**
 * VERIFICATION TOOL ONLY. Helpers of the 2x2 matrix scenario: cells with their own verdict, an MCP stdio client for `hatch mcp`,
 * Feishu and WeCom webhooks in the platforms' documented formats (signed and encrypted the way the adapters verify them),
 * and the Studio change flow (a price change that needs the Expert's confirmation).
 */

/** One cell of the matrix: its checks feed the scenario's recorder and its own verdict. */
export class Cell {
  constructor(id, title, rec) { this.id = id; this.title = title; this.rec = rec; this.failed = []; this.ids = {}; this.status = "PASS"; this.reason = undefined; }
  check(name, ok, detail) { this.rec.check(`[${this.id}] ${name}`, ok, detail); if (!ok) this.failed.push(name); return Boolean(ok); }
  /** Marks a sub-part that no product path reaches. The cell is BLOCKED only when nothing else in it ran. */
  block(reason) { throw new Blocked(reason); }
  verdict() { return { title: this.title, status: this.status, ...(this.reason ? { reason: this.reason } : {}), ...(this.failed.length ? { failed: this.failed } : {}), ids: this.ids }; }
}

/** Runs one cell. A thrown Blocked is BLOCKED; any other throw or failed check is FAIL. Never throws. */
export async function walk(matrix, rec, id, title, body) {
  const cell = new Cell(id, title, rec);
  try { await body(cell); } catch (error) {
    if (error instanceof Blocked) { cell.status = "BLOCKED"; cell.reason = error.message; }
    else { cell.status = "FAIL"; cell.reason = `tool or product error: ${error?.stack?.split("\n").slice(0, 3).join(" | ") ?? error}`; cell.check("cell ran to the end", false, String(error?.message ?? error)); }
  }
  if (cell.status === "PASS" && cell.failed.length) cell.status = "FAIL";
  matrix[id] = cell.verdict();
  return cell;
}

/** `hatch mcp` over stdio, as an MCP client speaks to it: newline-delimited JSON-RPC. */
export class McpClient {
  constructor({ apiUrl, apiKey, home }) { this.env = { PATH: process.env.PATH, HOME: home, HATCH_API_URL: apiUrl, HATCH_API_KEY: apiKey }; this.pending = new Map(); this.nextId = 1; this.buffer = ""; this.stderr = ""; }
  async start() {
    this.child = spawn(process.execPath, [CLI_BIN, "mcp"], { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk) => { this.buffer += chunk; let i; while ((i = this.buffer.indexOf("\n")) >= 0) { const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1); if (line.trim()) this.#reply(JSON.parse(line)); } });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    const init = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify-surfaces", version: "0" } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return init;
  }
  #reply(message) { const waiter = this.pending.get(message.id); if (waiter) { this.pending.delete(message.id); waiter(message); } }
  request(method, params, timeoutMs = 180_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`mcp ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, (message) => { clearTimeout(timer); message.error ? reject(new Error(`mcp ${method}: ${message.error.message}`)) : resolve(message.result); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  /** Calls a tool. Returns { isError, text, json } where json is the parsed text when it is JSON. */
  async tool(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    const text = result.content?.[0]?.text ?? "";
    let json; try { json = JSON.parse(text); } catch { /* an error message */ }
    return { isError: Boolean(result.isError), text, json };
  }
  close() { try { this.child.stdin.end(); this.child.kill(); } catch { /* gone */ } }
}

export const cliHome = (stack, name) => { const dir = path.join(stack.root, `home-${name}`); mkdirSync(dir, { recursive: true }); return dir; };

// ── Feishu / Lark: own-app webhooks ────────────────────────────────────

const FEISHU = { appId: "cli_verify_app", appSecret: "verify-app-secret", verificationToken: "verify-feishu-token", encryptKey: "verify-feishu-encrypt-key", botOpenId: "ou_verify_bot", tenantKey: "tk_verify" };
export const FEISHU_CREDENTIALS = { app_id: FEISHU.appId, app_secret: FEISHU.appSecret, verification_token: FEISHU.verificationToken, encrypt_key: FEISHU.encryptKey };

/** The Feishu endpoints the adapter's probe calls: a tenant token and the bot's identity. Sends are answered by the platform's default code 0. */
export function installFeishuResponders(platform) {
  platform.respond("open.feishu.cn", "/open-apis/auth/v3/tenant_access_token/internal", () => ({ status: 200, body: { code: 0, msg: "ok", tenant_access_token: "t-verify-tenant-token", expire: 7200 } }));
  platform.respond("open.feishu.cn", "/open-apis/bot/v3/info", () => ({ status: 200, body: { code: 0, msg: "ok", bot: { open_id: FEISHU.botOpenId, app_name: "verify" } } }));
}

/** Feishu events: AES-256-CBC with sha256(encryptKey), signed sha256(timestamp + nonce + encryptKey + body) in x-lark-* headers. */
export class FeishuWebhooks {
  constructor(registryUrl, accountId, { encryptKey = FEISHU.encryptKey, token = FEISHU.verificationToken } = {}) { this.url = `${registryUrl}/v1/channels/feishu/${accountId}/webhook`; this.encryptKey = encryptKey; this.token = token; this.counter = 1; }
  encrypt(plain, key = this.encryptKey) {
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", createHash("sha256").update(key).digest(), iv);
    return Buffer.concat([iv, cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
  }
  header(eventType) { return { event_id: `ev-${randomUUID()}`, event_type: eventType, token: this.token, tenant_key: FEISHU.tenantKey, create_time: String(Date.now()) }; }
  message({ openId, text, messageId = `om_${randomUUID().replaceAll("-", "")}`, chatId = `oc_${openId}`, chatType = "p2p" }) {
    return { schema: "2.0", header: this.header("im.message.receive_v1"), event: { sender: { sender_id: { open_id: openId }, sender_type: "user", tenant_key: FEISHU.tenantKey }, message: { message_id: messageId, chat_id: chatId, chat_type: chatType, message_type: "text", content: JSON.stringify({ text }) } } };
  }
  cardAction({ openId, taskId, action }) { return { schema: "2.0", header: this.header("card.action.trigger"), event: { operator: { open_id: openId }, action: { value: { taskId, action }, tag: "button" } } }; }
  /** `encrypted: false` posts the clear body (the adapter then verifies by signature all the same). `badSignature` corrupts the signature. */
  async post(body, { encrypted = true, badSignature = false } = {}) {
    const raw = JSON.stringify(encrypted ? { encrypt: this.encrypt(JSON.stringify(body)) } : body);
    const timestamp = String(Math.floor(Date.now() / 1000)); const nonce = randomUUID().slice(0, 8);
    const signature = createHash("sha256").update(timestamp + nonce + this.encryptKey + raw).digest("hex");
    const response = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json", "x-lark-request-timestamp": timestamp, "x-lark-request-nonce": nonce, "x-lark-signature": badSignature ? "0".repeat(64) : signature }, body: raw });
    return { status: response.status, text: await response.text() };
  }
}

/** Sends of the Feishu adapter that reached the fake platform: create (open_id) or reply (message_id), with the decoded content. */
export function feishuSends(platform) {
  return platform.calls.filter((call) => call.host === "open.feishu.cn" && /^\/open-apis\/im\/v1\/messages(\/[^/]+\/reply)?$/.test(call.path) && call.delivered).map((call) => {
    let content; try { content = JSON.parse(call.body.content); } catch { content = {}; }
    const card = call.body.msg_type === "interactive" ? content : undefined;
    const buttons = (card?.body?.elements ?? []).filter((element) => element.tag === "button").map((element) => ({ label: element.text.content, ...element.behaviors[0].value }));
    return { at: call.at, path: call.path, text: card ? card.body.elements.find((e) => e.tag === "div")?.text?.content : content.text, receiveId: call.body.receive_id, msgType: call.body.msg_type, buttons, authorization: call.headers.authorization ? "present" : "absent", uuid: call.body.uuid };
  });
}

// ── WeCom smart bot (URL callback): own-app webhooks ──────────────────

export const WECOM = { token: "verify-wecom-token", encodingAesKey: randomBytes(32).toString("base64").slice(0, 43) };
export const WECOM_CREDENTIALS = { token: WECOM.token, encoding_aes_key: WECOM.encodingAesKey };

/** WeCom callbacks: WXBizMsgCrypt. Body {encrypt}, query msg_signature = sha1(sorted token, timestamp, nonce, encrypt). */
export class WeComWebhooks {
  constructor(registryUrl, accountId, { token = WECOM.token, encodingAesKey = WECOM.encodingAesKey } = {}) { this.base = `${registryUrl}/v1/channels/wecom/${accountId}/webhook`; this.token = token; this.key = Buffer.from(`${encodingAesKey}=`, "base64"); }
  sign(timestamp, nonce, encrypted) { return createHash("sha1").update([this.token, timestamp, nonce, encrypted].sort().join("")).digest("hex"); }
  encrypt(message) {
    const body = Buffer.from(message, "utf8"); const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
    const plain = Buffer.concat([randomBytes(16), length, body]);
    const pad = 32 - (plain.length % 32);
    const cipher = createCipheriv("aes-256-cbc", this.key, this.key.subarray(0, 16)).setAutoPadding(false);
    return Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()]).toString("base64");
  }
  /** A single-chat text message. response_url is the one-shot reply address, on the platform host (the fake platform answers it). */
  message({ userId, text, msgid = `msg-${randomUUID()}`, responseUrl = `https://qyapi.weixin.qq.com/cgi-bin/aibot/response/${randomUUID()}` }) {
    return { msgid, aibotid: "AIBOT_VERIFY", chattype: "single", from: { userid: userId }, response_url: responseUrl, msgtype: "text", text: { content: text } };
  }
  query(encrypted, { badSignature = false } = {}) {
    const timestamp = String(Math.floor(Date.now() / 1000)); const nonce = randomUUID().slice(0, 8);
    return new URLSearchParams({ msg_signature: badSignature ? "0".repeat(40) : this.sign(timestamp, nonce, encrypted), timestamp, nonce });
  }
  async post(message, { badSignature = false } = {}) {
    const encrypt = this.encrypt(JSON.stringify(message));
    const response = await fetch(`${this.base}?${this.query(encrypt, { badSignature })}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ encrypt }) });
    return { status: response.status, text: await response.text() };
  }
  /** The GET WeCom makes when the URL is saved: the encrypted echostr must come back decrypted. */
  async verifyUrl(echo = "verify-echo") {
    const encrypted = this.encrypt(echo);
    const response = await fetch(`${this.base}?${new URLSearchParams({ ...Object.fromEntries(this.query(encrypted)), echostr: encrypted })}`);
    return { status: response.status, text: await response.text(), expected: echo };
  }
}

/** Replies of the WeCom adapter on the fake platform: one POST per inbound message to its response_url. */
export const wecomSends = (platform) => platform.calls.filter((call) => call.host === "qyapi.weixin.qq.com" && call.path.startsWith("/cgi-bin/aibot/response/") && call.delivered).map((call) => ({ at: call.at, path: call.path, msgtype: call.body.msgtype, text: call.body.markdown?.content }));

// ── Studio change flow: a price that changes only after the Expert confirms ──

export const PRICE = { before: { human_hourly_minor: 10000, agent_monthly_minor: 2900 }, approved: { human_hourly_minor: 20000, agent_monthly_minor: 4900 }, declined: { human_hourly_minor: 30000, agent_monthly_minor: 5900 } };
export const proposeText = (productId, price) => `请调用 propose_change 工具：agent_id 是 ${productId}，pricing 设为 {"human_hourly_minor":${price.human_hourly_minor},"agent_monthly_minor":${price.agent_monthly_minor},"free_messages":null,"currency":"USD"}。只提议，不要自己确认，也不要调用 approve_task，等我确认。`;

export class PricedProduct {
  constructor(stack, studio, account) { this.stack = stack; this.studio = studio; this.account = account; }
  /** A draft Product through the real create route, then its first price through the real pricing route. */
  async create(name, created) {
    this.id = created ?? (await this.studio.call("POST", "/v1/creator/products", { body: { name, promise: `${name}: verification product` } })).json?.product?.product_id;
    if (!this.id) throw new Error("no product id");
    const put = await this.studio.call("PUT", `/v1/creator/products/${this.id}/pricing`, { body: { pricing: { ...PRICE.before, free_messages: null, currency: "USD" } } });
    if (put.status !== 200) throw new Error(`set initial pricing: ${put.status} ${put.text.slice(0, 200)}`);
    return this.id;
  }
  async price() { const r = await this.studio.call("GET", `/v1/creator/products/${this.id}`); return { status: r.status, pricing: r.json?.product?.pricing }; }
  async tasks() { return (await this.stack.registryPool.query("SELECT id, kind, status, needs, payload, summary, origin, updated_at FROM hatch_assistant_tasks WHERE account_id = $1 ORDER BY created_at", [this.account.id])).rows; }
  async task(id) { return (await this.tasks()).find((task) => task.id === id); }
  /** Waits for a new change task of this Product that needs the Expert's review. */
  async nextChange(knownIds, price, timeoutMs = 150_000) {
    return until("a pending change task", async () => (await this.tasks()).find((task) => !knownIds.has(task.id) && task.kind === "change" && task.payload?.change?.pricing && Number(task.payload.change.pricing.human_hourly_minor) === price.human_hourly_minor), { timeoutMs, everyMs: 500 });
  }
  /** Price as number pair, for a compact comparison. */
  static same(pricing, price) { return Number(pricing?.human_hourly_minor) === price.human_hourly_minor && Number(pricing?.agent_monthly_minor) === price.agent_monthly_minor; }
}

export { sleep };
