import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { BROWSER_ORIGIN } from "./stack.mjs";
import { sleep } from "./util.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const CLI_BIN = path.join(repoRoot, "packages/hatch-cli/bin/hatch.js");

/** How a client proves who it is. `browser` is the session cookie from an allowed Origin; `bearer` is a session token or API key in Authorization. */
export class Auth {
  constructor(kind, token) { this.kind = kind; this.token = token; }
  static bearer(token) { return new Auth("bearer", token); }
  static browserCookie(token) { return new Auth("cookie", token); }
  headers() { return this.kind === "cookie" ? { cookie: `hatch_session=${encodeURIComponent(this.token)}`, origin: BROWSER_ORIGIN } : { authorization: `Bearer ${this.token}` }; }
}

export async function* sseFrames(response, signal) {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = response.body.getReader();
  signal?.addEventListener("abort", () => reader.cancel().catch(() => undefined));
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const frame = { id: undefined, event: undefined, data: undefined, at: Date.now() };
        for (const line of block.split("\n")) {
          if (line.startsWith("id:")) frame.id = line.slice(3).trim();
          else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
          else if (line.startsWith("data:")) frame.data = (frame.data ?? "") + line.slice(5).trim();
        }
        if (frame.data !== undefined) { try { frame.json = JSON.parse(frame.data); } catch { /* keep raw */ } yield frame; }
      }
    }
  } catch (error) { if (!signal?.aborted) throw error; }
}

class HttpApi {
  constructor(base, auth) { this.base = base; this.auth = auth; }
  async call(method, pathname, { body, headers = {}, raw } = {}) {
    const started = Date.now();
    const response = await fetch(this.base + pathname, { method, headers: { ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}), ...this.auth?.headers(), ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await response.text();
    let json; try { json = text ? JSON.parse(text) : undefined; } catch { /* not json */ }
    return { status: response.status, json, text, ms: Date.now() - started, headers: response.headers };
  }
  async stream(method, pathname, { body, headers = {}, signal } = {}) {
    const response = await fetch(this.base + pathname, { method, signal, headers: { accept: "text/event-stream", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...this.auth?.headers(), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) { const text = await response.text(); throw Object.assign(new Error(`stream ${pathname} -> ${response.status} ${text.slice(0, 200)}`), { status: response.status }); }
    return { response, frames: sseFrames(response, signal) };
  }
}

/** Chat API: a conversation between an account (or contact) and a published Product, on the Runtime. */
export class ChatApi extends HttpApi {
  q(productId, extra = {}) { const params = new URLSearchParams({ product_id: productId, ...extra }); return `?${params}`; }
  async create(productId, clientRequestId = randomUUID(), briefAnswers = []) { const r = await this.call("POST", `/v1/conversations${this.q(productId)}`, { body: { client_request_id: clientRequestId, brief_answers: briefAnswers } }); if (!r.json?.conversation) throw new Error(`create conversation: ${r.status} ${r.text.slice(0, 300)}`); return r.json.conversation.id; }
  /** `body` may carry `content` or `parts`, plus `client`. `key` is the client_message_id. */
  send(conversationId, productId, { key = randomUUID(), content, parts, client, wait, headers, extra = {} }) {
    const body = { client_message_id: key, ...(parts ? { parts } : { content }), ...(client ? { client } : {}), ...extra };
    return this.call("POST", `/v1/conversations/${conversationId}/messages${this.q(productId, wait ? { wait: String(wait) } : {})}`, { body, headers });
  }
  sendSse(conversationId, productId, { key = randomUUID(), content, signal, client }) { return this.stream("POST", `/v1/conversations/${conversationId}/messages${this.q(productId)}`, { body: { client_message_id: key, content, ...(client ? { client } : {}) }, signal }); }
  snapshot(conversationId, productId, afterCursor) { return this.call("GET", `/v1/conversations/${conversationId}/snapshot${this.q(productId, afterCursor !== undefined ? { after_cursor: String(afterCursor) } : {})}`); }
  history(conversationId, productId) { return this.call("GET", `/v1/conversations/${conversationId}/history${this.q(productId, { limit: "100" })}`); }
  runs(conversationId, productId) { return this.call("GET", `/v1/conversations/${conversationId}/runs${this.q(productId)}`); }
  run(conversationId, productId, runId) { return this.call("GET", `/v1/conversations/${conversationId}/runs/${runId}${this.q(productId)}`); }
  events(conversationId, productId, { after, signal } = {}) { return this.stream("GET", `/v1/conversations/${conversationId}/events${this.q(productId, after !== undefined ? { after_cursor: String(after) } : {})}`, { signal }); }
  cancel(conversationId, productId, runId) { return this.call("POST", `/v1/conversations/${conversationId}/runs/${runId}/cancel${this.q(productId)}`, { body: {} }); }
  upload(conversationId, productId, name, bytes) { return this.call("POST", `/v1/conversations/${conversationId}/assets${this.q(productId, { name })}`, { raw: bytes, headers: { "content-type": "application/octet-stream" } }); }
  toolResult(conversationId, productId, body) { return this.call("POST", `/v1/conversations/${conversationId}/tool-results${this.q(productId)}`, { body }); }
  /** Waits until the run is terminal. Returns the run and the visible reply text. */
  async finish(conversationId, productId, runId, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.run(conversationId, productId, runId);
      const status = r.json?.run?.status;
      if (["completed", "failed", "cancelled", "interrupted"].includes(status)) return { run: r.json.run, status };
      if (Date.now() > deadline) throw new Error(`run ${runId} still ${status} after ${timeoutMs} ms`);
      await sleep(250);
    }
  }
  async messages(conversationId, productId) { return (await this.history(conversationId, productId)).json?.messages ?? []; }
}

/** Studio API: Product workers and the Assistant, on the Registry. */
export class StudioApi extends HttpApi {
  workerPath(productId, worker) { return `/v1/creator/products/${productId}/workers/${worker}`; }
  workers(productId) { return this.call("GET", `/v1/creator/products/${productId}/workers`); }
  sendWorker(productId, worker, { content, key, client, wait, accept }) { return this.call("POST", `${this.workerPath(productId, worker)}/messages${wait ? `?wait=${wait}` : ""}`, { body: { content, ...(client ? { client } : {}) }, headers: { "idempotency-key": key ?? randomUUID() } }); }
  messagesWorker(productId, worker, after) { return this.call("GET", `${this.workerPath(productId, worker)}/messages${after ? `?after=${after}` : ""}`); }
  snapshotWorker(productId, worker) { return this.call("GET", `${this.workerPath(productId, worker)}/snapshot`); }
  eventsWorker(productId, worker, { after, signal } = {}) { return this.stream("GET", `${this.workerPath(productId, worker)}/events${after ? `?after=${encodeURIComponent(after)}` : ""}`, { signal }); }
  stopWorker(productId, worker) { return this.call("POST", `${this.workerPath(productId, worker)}/stop`, { body: {} }); }
  sendAssistant({ content, key, client, wait }) { return this.call("POST", `/v1/creator/assistant/conversation/messages${wait ? `?wait=${wait}` : ""}`, { body: { content, ...(client ? { client } : {}) }, headers: { "idempotency-key": key ?? randomUUID() } }); }
  messagesAssistant(after) { return this.call("GET", `/v1/creator/assistant/conversation/messages${after ? `?after=${after}` : ""}`); }
  snapshotAssistant() { return this.call("GET", "/v1/creator/assistant/conversation/snapshot"); }
  eventsAssistant({ after, signal } = {}) { return this.stream("GET", `/v1/creator/assistant/conversation/events${after ? `?after=${encodeURIComponent(after)}` : ""}`, { signal }); }
  assistantView() { return this.call("GET", "/v1/creator/assistant"); }
  approveTask(taskId) { return this.call("POST", `/v1/creator/assistant/tasks/${taskId}/approve`, { body: {}, headers: { "idempotency-key": randomUUID() } }); }
}

/** A WebSocket client that records every frame with its arrival time. */
class JsonSocket {
  constructor(url, headers = {}) {
    this.frames = [];
    this.closed = undefined;
    this.waiters = [];
    this.ws = new WebSocket(url, { headers });
    this.ws.on("message", (data) => { const frame = JSON.parse(data.toString()); frame.__at = Date.now(); this.frames.push(frame); this.waiters = this.waiters.filter((w) => !w()); });
    this.ws.on("close", (code, reason) => { this.closed = { code, reason: reason.toString(), at: Date.now() }; this.waiters = this.waiters.filter((w) => !w()); });
    this.opened = new Promise((resolve, reject) => { this.ws.once("open", resolve); this.ws.once("error", reject); this.ws.once("unexpected-response", (_r, response) => reject(Object.assign(new Error(`upgrade refused: ${response.statusCode}`), { status: response.statusCode }))); });
  }
  send(value) { this.ws.send(JSON.stringify(value)); }
  waitFor(what, predicate, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const found = this.frames.find(predicate);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}; got ${this.frames.slice(-5).map((f) => f.type).join(",")}`)), timeoutMs);
      this.waiters.push(() => { const hit = this.frames.find(predicate); if (this.closed && !hit) { clearTimeout(timer); reject(new Error(`socket closed (${this.closed.code}) while waiting for ${what}`)); return true; } if (hit) { clearTimeout(timer); resolve(hit); return true; } return false; });
    });
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
  terminate() { this.ws.terminate(); }
}

/** The Desktop protocol on the Runtime (`/runtime`): hello, messages, subscribe. */
export class ChatSocket extends JsonSocket {
  /** `auth`: Auth.browserCookie / Auth.bearer on the upgrade, or `firstMessage: true` to send the token in the hello instead. */
  static async open(base, { auth, productId, conversationId, client = { client: "desktop", device: "mac" }, localTools = [], firstMessage = false }) {
    const socket = new ChatSocket(`${base.replace(/^http/, "ws")}/v1/runtime`, firstMessage ? {} : auth.headers());
    await socket.opened;
    socket.conversationId = conversationId;
    socket.send({ type: "client.hello", protocol_version: "0.8", conversation_id: conversationId, ...(firstMessage ? { auth_token: auth.token } : {}), product_id: productId, local_tools: localTools, ...client });
    await socket.waitFor("session.ready", (f) => f.type === "session.ready" || f.type === "turn.failed");
    if (socket.frames.at(-1)?.type === "turn.failed" && !socket.frames.some((f) => f.type === "session.ready")) { socket.close(); throw new Error(`hello refused: ${JSON.stringify(socket.frames.at(-1).error)}`); }
    return socket;
  }
  message(text, { runId = `run_${randomUUID().replaceAll("-", "")}`, key = randomUUID(), client = {} } = {}) {
    this.send({ type: "client.message", run_id: runId, client_message_id: key, conversation_id: this.conversationId, message: { role: "user", content: text }, ...client });
    return { runId, key };
  }
  subscribe({ stream, after }) { this.send({ type: "conversation.subscribe", conversation_id: this.conversationId, stream, ...(after !== undefined ? { after_cursor: after } : {}) }); }
}

/** Studio over WebSocket: subscribe to a worker or the Assistant. */
export class StudioSocket extends JsonSocket {
  static async open(base, { auth, firstMessage = false }) {
    const socket = new StudioSocket(`${base.replace(/^http/, "ws")}/v1/creator/studio/ws`, firstMessage ? {} : auth.headers());
    await socket.opened;
    if (firstMessage) socket.send({ type: "auth", token: auth.token });
    await socket.waitFor("ready", (f) => f.type === "ready" || f.type === "error");
    if (socket.frames.some((f) => f.type === "error")) throw new Error(`studio socket refused: ${JSON.stringify(socket.frames.find((f) => f.type === "error"))}`);
    return socket;
  }
  subscribe(id, target, { stream, after } = {}) { this.send({ type: "subscribe", id, target, stream: Boolean(stream), ...(after !== undefined ? { after } : {}) }); }
}

/** The real `hatch` CLI (packages/hatch-cli) as a child process, signed in only by HATCH_API_KEY. */
export class HatchCli {
  constructor({ apiUrl, apiKey, home }) { this.apiUrl = apiUrl; this.apiKey = apiKey; this.home = home; }
  run(args, { env = {}, timeoutMs = 180_000, killAfterMs } = {}) {
    const child = spawn(process.execPath, [CLI_BIN, "--json", ...args], { env: { PATH: process.env.PATH, HOME: this.home, HATCH_API_URL: this.apiUrl, HATCH_API_KEY: this.apiKey, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const started = Date.now();
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("exit", (code, signal) => { clearTimeout(timer); let json; try { json = JSON.parse(stdout); } catch { /* streamed or plain */ } resolve({ code, signal, stdout, stderr, json, ms: Date.now() - started }); });
    });
    if (killAfterMs) setTimeout(() => child.kill("SIGKILL"), killAfterMs);
    return { child, done, stdout: () => stdout };
  }
}
