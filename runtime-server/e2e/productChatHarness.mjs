// Product Chat end to end, in one process: the real Runtime, the Dashboard's real browser bridge, a TCP proxy that
// can drop or silence the network, and the real packages/chat ConversationController with the Dashboard's real
// browser transport (Node 22 has the WebSocket the transport uses). Automated tests only.
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { AttachmentSource, ConversationController, MemoryDraftStore } from "../../packages/chat/src/index.js";
import * as client from "../../creator-dashboard/src/webChatClient.js";
import { WebChatRuntimeBridge } from "../../creator-dashboard/webChatRuntimeBridge.mjs";
import { createRuntimeServer } from "../dist/index.js";
import { RuntimeStore } from "../dist/store.js";

// A browser always fires `close` after a failed connection; Node's WebSocket fires only `error`. The page is written for the browser.
const NodeWebSocket = globalThis.WebSocket;
class BrowserLikeWebSocket extends NodeWebSocket {
  #close;
  #closed = false;
  constructor(...args) {
    super(...args);
    const close = event => { if (this.#closed) return; this.#closed = true; this.#close?.(event); };
    this.addEventListener("close", close);
    this.addEventListener("error", () => setTimeout(() => close({ code: 1006 }), 0));
  }
  set onclose(handler) { this.#close = handler; }
  get onclose() { return this.#close; }
}
globalThis.WebSocket = BrowserLikeWebSocket;

export const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";
const CREATOR_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "acct-token";

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function until(check, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await check(); } catch { value = false; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/** A promise a test opens by hand. */
export const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return Object.assign(promise, { open }); };

/**
 * The model: for each Run it says `first`, waits for gate 1, takes the messages that joined the Run, says `second`,
 * waits for gate 2, and ends. Gates are per message content, so a test steps one Run through its phases.
 */
export class ScriptedModel {
  constructor() { this.gates = new Map(); this.runs = []; }
  gatesFor(content) {
    if (!this.gates.has(content)) this.gates.set(content, { first: gate(), claim: gate(), end: gate() });
    return this.gates.get(content);
  }
  open(content, ...names) { for (const name of names) this.gatesFor(content)[name].open(); }
  runtime() {
    return { run: async function* (input, ctx) {
      const content = input.message?.content ?? "";
      const gates = this.gatesFor(content);
      this.runs.push(content);
      yield { type: "assistant.delta", run_id: input.run_id, delta: { kind: "text", content: `[${content}:1]` } };
      await gates.first;
      yield { type: "assistant.delta", run_id: input.run_id, delta: { kind: "text", content: `[${content}:2]` } };
      await gates.claim;
      if (ctx.claimSteered) await ctx.claimSteered();
      await gates.end;
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }.bind(this) };
  }
}

/** A TCP proxy in front of the Dashboard: drop everything, or keep WebSockets open and silent (a half-open connection). */
export class ChaosProxy {
  constructor(target) {
    this.target = target;
    this.pairs = new Set();
    this.down = false;
    this.accepted = 0;
    this.server = net.createServer(socket => this.accept(socket));
  }
  async start() { this.port = await listen(this.server); return this; }
  accept(socket) {
    this.accepted += 1;
    if (this.down) { socket.destroy(); return; }
    const upstream = net.connect(this.target);
    const pair = { socket, upstream, websocket: false, silent: false };
    this.pairs.add(pair);
    const end = () => { this.pairs.delete(pair); socket.destroy(); upstream.destroy(); };
    socket.on("error", end); upstream.on("error", end); socket.on("close", end); upstream.on("close", end);
    socket.on("data", chunk => {
      if (!pair.websocket && /upgrade:\s*websocket/i.test(chunk.toString("latin1", 0, 2048))) pair.websocket = true;
      if (!pair.silent) upstream.write(chunk);
    });
    upstream.on("data", chunk => { if (!pair.silent) socket.write(chunk); });
  }
  /** The network is gone: open connections die, new ones are refused. */
  drop() { this.down = true; for (const pair of [...this.pairs]) { pair.socket.destroy(); pair.upstream.destroy(); } }
  restore() { this.down = false; }
  /** Open WebSockets stay open and carry nothing either way; new connections work. */
  silence() { for (const pair of this.pairs) if (pair.websocket) pair.silent = true; }
  async close() { this.drop(); await new Promise(resolve => this.server.close(resolve)); }
}

/** The Runtime, the Dashboard's web-chat proxy and bridge, and the proxy in front of them. */
export async function startStack({ heartbeatMs = 10_000 } = {}) {
  const model = new ScriptedModel();
  const accounts = { [TOKEN]: ACCOUNT_ID };
  const corpus = { agent_id: PRODUCT_ID, creator: { id: CREATOR_ID, name: "Maya" }, product: { id: PRODUCT_ID, name: "Resume Review", boundaries: [], presentation: {} }, tools: [] };
  const resolved = () => ({ root: "", digest: `sha256:${"a".repeat(64)}`, corpus });
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(path.join(await mkdtemp(path.join(os.tmpdir(), "hatch-product-chat-")), "runtime")),
    authIdentityResolver: { resolveIdentity: async token => token && accounts[token] ? { sub: accounts[token] } : undefined },
    entitlementResolver: { list: async () => [] },
    agentCorpusResolver: { resolve: async () => resolved(), resolveByProduct: async () => resolved(), list: async () => [] },
    createRuntime: () => model.runtime()
  });
  const runtimePort = await listen(runtime.server);
  const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
  const chatWss = new WebSocketServer({ noServer: true });
  const bridges = new Set();
  const dashboard = http.createServer(async (request, response) => {
    // /v1/web-chat/conversations... is the Runtime's /v1/conversations... with the session's token.
    const target = `${runtimeUrl}${request.url.replace("/v1/web-chat/conversations", "/v1/conversations")}`;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const upstream = await fetch(target, { method: request.method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
  dashboard.on("upgrade", (request, socket, head) => {
    chatWss.handleUpgrade(request, socket, head, browser => {
      const bridge = new WebChatRuntimeBridge({ browser, runtimeUrl, token: TOKEN, heartbeatMs });
      bridges.add(bridge);
      bridge.connect();
    });
  });
  const dashboardPort = await listen(dashboard);
  const proxy = await new ChaosProxy({ host: "127.0.0.1", port: dashboardPort }).start();
  globalThis.location = { protocol: "http:", host: `127.0.0.1:${proxy.port}` };
  const request = async (url, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}${url}`, { ...init, headers: { "content-type": "application/json" } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body?.error?.code ?? `HTTP ${response.status}`), { status: response.status, code: body?.error?.code });
    return body;
  };
  const direct = async route => (await fetch(`${runtimeUrl}${route}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  return {
    model, proxy, request, runtimeUrl,
    async newConversation() {
      const { conversation } = await request(`/v1/web-chat/conversations?product_id=${PRODUCT_ID}`, { method: "POST", body: JSON.stringify({ client_request_id: crypto.randomUUID() }) });
      return conversation.id;
    },
    /** What the server holds of the conversation, as its page says. */
    async messages(conversationId) {
      const snapshot = await direct(`/v1/conversations/${conversationId}/snapshot?product_id=${PRODUCT_ID}&view=page`);
      return snapshot.messages ?? [];
    },
    async close() {
      await proxy.close();
      for (const socket of chatWss.clients) socket.terminate();
      chatWss.close();
      dashboard.closeAllConnections?.();
      await new Promise(resolve => dashboard.close(resolve));
      await runtime.close();
    }
  };
}

class NoImages extends AttachmentSource { accepts() { return false; } prepareAll() { return Promise.resolve([]); } }

/** A session storage shared by the "reloads" of one tab. */
export const tabStorage = () => { const map = new Map(); return () => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }); };

/** A page: the Dashboard's own transport and controller settings, `overrides` only to speed the clocks up. */
export function openPage(stack, conversationId, { storage = tabStorage(), overrides = {} } = {}) {
  const settings = client.webChatControllerOptions?.(PRODUCT_ID, storage) ?? {};
  const controller = new ConversationController({
    transport: new client.WebConversationTransport(stack.request, { product_id: PRODUCT_ID }),
    attachments: new NoImages(), tools: new client.UnavailableToolExecutor(), drafts: new MemoryDraftStore(), draftScope: PRODUCT_ID,
    pollMs: 500, ...settings, ...overrides
  });
  controller.open(conversationId);
  const page = {
    controller, storage,
    state: () => controller.getState(),
    rows: () => controller.getState().messages.map(message => `${message.role}${message.transient ? "*" : ""}:${message.content ?? ""}${message.state ? `(${message.state})` : ""}`),
    row: text => controller.getState().messages.find(message => message.role === "user" && message.content === text),
    liveText: () => controller.getState().messages.filter(message => message.transient).flatMap(message => (message.timeline ?? []).map(entry => entry.content ?? entry.text ?? "")).join(""),
    async say(text) { controller.setDraft(text); await controller.send(); },
    close() { controller.dispose(); }
  };
  return page;
}
