import assert from "node:assert/strict";
import test from "node:test";
import { ConversationController } from "@hatch/chat";
import { ASSISTANT_CONVERSATION, SessionPendingStore, StudioAssistantTransport, StudioAttachments } from "./studioAssistantTransport.js";

const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const ROOT = "/v1/creator/assistant/conversation";

/** An EventSource double: automated tests only. */
class FakeSource {
  constructor(url) { this.url = url; FakeSource.all.push(this); setImmediate(() => this.onopen?.()); }
  emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
  close() { this.closed = true; }
}
FakeSource.all = [];

const view = (extra = {}) => ({ status: { state: "idle" }, tasks: [], channels: [], ...extra });

/** The Assistant's server: a log of public events (the same shape Product Chat serves), the view, and the writes. */
function server({ events = [], view: viewBody = view() } = {}) {
  const calls = [];
  const state = { events, view: viewBody, sent: [] };
  const request = async (path, init) => {
    calls.push([init?.method ?? "GET", path]);
    if (init?.method === "POST") { state.sent.push({ path, key: init.headers?.["idempotency-key"], body: JSON.parse(init.body) }); return { run_id: "run_1", queued: false }; }
    if (init?.method === "PUT") return { timezone: "UTC" };
    const url = new URL(path, "http://x");
    if (url.pathname === `${ROOT}/view`) return state.view;
    if (url.pathname === `${ROOT}/log`) {
      const after = Number(url.searchParams.get("after") ?? 0);
      const later = state.events.filter(event => event.position > after);
      const page = later.slice(0, Number(url.searchParams.get("limit") ?? later.length));
      return url.searchParams.has("turns") ? { events: state.events, head: state.events.at(-1)?.position ?? 0, start: state.events[0]?.position ?? 0, has_more_before: false } : { events: page, head: state.events.at(-1)?.position ?? 0, has_more: page.length < later.length };
    }
    throw new Error(`unexpected ${path}`);
  };
  return { state, calls, request };
}

const event = (position, type, fields = {}) => ({ position, type, at: "2026-11-01T00:00:00Z", ...fields });

function setup(options) {
  FakeSource.all = [];
  const api = server(options);
  const transport = new StudioAssistantTransport(api.request, { stream: url => new FakeSource(url), timeZone: "UTC" });
  const store = new SessionPendingStore(() => ({ getItem: () => store.raw ?? null, setItem: (_key, value) => { store.raw = value; } }));
  const controller = new ConversationController({ transport, attachments: new StudioAttachments(api.request), tools: { localTools: [], prepareRun: async () => {}, cancel() {} }, pendingStore: store, pollMs: 60_000, reconnectAttempts: 0 });
  return { ...api, transport, controller, store };
}

test("the first page is the latest turns of the log, with the view beside it and the timezone told once, by PUT", async () => {
  const { transport, calls } = setup({ events: [event(1, "user.message", { id: "m1", run_id: "r1", content: "hi" })], view: view({ tasks: [{ id: "t1", status: "needs_you" }], channels: [{ kind: "lark", own_app: true }] }) });
  const page = await transport.log(ASSISTANT_CONVERSATION, { turns: 20 });
  await transport.log(ASSISTANT_CONVERSATION, { turns: 20 });
  assert.deepEqual(page.events.map(entry => entry.id), ["m1"]);
  assert.deepEqual([transport.getView().tasks[0].id, transport.getView().channels[0].kind], ["t1", "lark"]);
  assert.deepEqual(calls.filter(([method]) => method === "PUT"), [["PUT", `${ROOT}/timezone`]]);
  assert.deepEqual(calls.filter(([, path]) => path.startsWith(`${ROOT}/log`)).map(([, path]) => path), [`${ROOT}/log?turns=20`, `${ROOT}/log?turns=20`]);
  await transport.log(ASSISTANT_CONVERSATION, { turns: 20, before: 7 });
  assert.equal(calls.at(-1)[1], `${ROOT}/log?turns=20&before=7`, "older turns do not read the view again");
});

test("a file of a message reads as the shared chat reads it, whichever shape the log names it in", async () => {
  const { transport } = setup({ events: [event(1, "user.message", { id: "m1", run_id: "r1", content: "see", attachments: [{ type: "file", name: "notes.pdf", asset_id: "f1", bytes: 2048 }] })] });
  const page = await transport.log(ASSISTANT_CONVERSATION, { turns: 20 });
  assert.deepEqual(page.events[0].attachments, [{ attachment_id: "f1", asset_id: "f1", display_name: "notes.pdf", media_type: "application/octet-stream", source_bytes: 2048 }]);
  assert.equal(transport.assetUrl(ASSISTANT_CONVERSATION, "img 1"), `${ROOT}/assets/img%201`);
});

test("the page opens on the log, and the live session brings what is new: the stream says the log moved, the log is read from the position held", async () => {
  const { controller, state } = setup({ events: [event(1, "user.message", { id: "m1", run_id: "r1", content: "hello" }), event(2, "run.state", { run_id: "r1", status: "running" }), event(3, "assistant.text", { run_id: "r1", content: "so far" })] });
  controller.open(ASSISTANT_CONVERSATION);
  await flush();
  const [stream] = FakeSource.all;
  assert.equal(stream.url, `${ROOT}/events`);
  const reply = () => controller.state.messages.at(-1);
  assert.equal(reply().content, "so far");
  assert.equal(controller.state.activeRun, "r1");
  state.events.push(event(4, "tool.call", { run_id: "r1", tool_call_id: "t1", name: "list_agents", status: "requested" }), event(5, "assistant.text", { run_id: "r1", content: " and more" }));
  stream.emit({ type: "delta" });
  await flush();
  assert.deepEqual(reply().timeline.map(entry => entry.kind), ["text", "tool", "text"]);
  state.events.push(event(6, "tool.call", { run_id: "r1", tool_call_id: "t1", name: "list_agents", status: "completed" }), event(7, "run.state", { run_id: "r1", status: "completed" }));
  stream.emit({ type: "delta" });
  stream.emit({ type: "delta" });
  await flush();
  assert.equal(controller.state.activeRun, null);
  assert.equal(reply().transient, undefined);
  assert.equal(reply().timeline[1].status, "completed");
  controller.dispose();
});

test("a state event reads the view again, and so does the end of a Run", async () => {
  const { controller, state, transport } = setup({ events: [event(1, "user.message", { id: "m1", run_id: "r1" }), event(2, "run.state", { run_id: "r1", status: "running" })] });
  controller.open(ASSISTANT_CONVERSATION);
  await flush();
  state.view = view({ tasks: [{ id: "t9", status: "needs_you" }] });
  FakeSource.all[0].emit({ type: "state" });
  await flush();
  assert.equal(transport.getView().tasks[0].id, "t9");
  state.view = view({ tasks: [] });
  state.events.push(event(3, "run.state", { run_id: "r1", status: "completed" }));
  FakeSource.all[0].emit({ type: "delta" });
  await flush();
  assert.deepEqual(transport.getView().tasks, []);
  controller.dispose();
});

test("a reload resumes the log from the position held: a new session starts its read there", async () => {
  const { controller, state, calls } = setup({ events: [event(1, "user.message", { id: "m1", run_id: "r1" }), event(2, "run.state", { run_id: "r1", status: "running" })] });
  controller.open(ASSISTANT_CONVERSATION);
  await flush();
  state.events.push(event(3, "assistant.text", { run_id: "r1", content: "while the stream was down" }));
  controller.reconnect();
  await flush();
  assert.ok(calls.some(([, path]) => path === `${ROOT}/log?after=2&limit=200`));
  assert.equal(controller.state.messages.at(-1).content, "while the stream was down");
  controller.dispose();
});

test("a message goes out under its own key as Idempotency-Key, files first, and a reload sends the same key again", async () => {
  const { controller, state, store } = setup();
  controller.open(ASSISTANT_CONVERSATION);
  await flush();
  controller.setDraft("one");
  await controller.send();
  controller.setDraft("one");
  await controller.send();
  await flush();
  assert.equal(state.sent.length, 2);
  assert.notEqual(state.sent[0].key, state.sent[1].key, "the same words twice are two messages");
  assert.equal(state.sent[0].path, `${ROOT}/messages`);
  assert.equal(state.sent[0].body.content, "one");
  controller.dispose();

  store.save({ conversationId: ASSISTANT_CONVERSATION, clientMessageId: "message_lost", content: "before reload", attachments: [{ asset_id: "a", type: "image" }] });
  const reloaded = setup();
  reloaded.store.raw = store.raw;
  reloaded.controller.open(ASSISTANT_CONVERSATION);
  await flush();
  assert.deepEqual(reloaded.state.sent.map(entry => [entry.key, entry.body.content]), [["message_lost", [{ type: "text", text: "before reload" }, { type: "image", assetId: "a" }]]]);
  reloaded.controller.dispose();
});

test("an unreadable session storage is no pending messages, not an error", () => {
  const store = new SessionPendingStore(() => ({ getItem: () => "{not json", setItem() { throw new Error("full"); } }));
  assert.deepEqual(store.load(ASSISTANT_CONVERSATION), []);
  store.save({ conversationId: ASSISTANT_CONVERSATION, clientMessageId: "m", content: "x", attachments: [] });
});

test("answering a failed Run again posts to /retry under the key as its Idempotency-Key", async () => {
  const calls = [];
  const transport = new StudioAssistantTransport(async (path, init) => { calls.push({ path, init }); return { accepted: true, run_id: "run_9", outcome: "started" }; }, { stream: url => new FakeSource(url), timeZone: "UTC" });
  assert.equal(transport.retriesRun, true);
  assert.deepEqual(await transport.retryRun(ASSISTANT_CONVERSATION, "retry_1"), { accepted: true, run_id: "run_9", outcome: "started" });
  assert.equal(calls[0].path, `${ROOT}/retry`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["idempotency-key"], "retry_1");
});

test("a file goes up as its own bytes with its name in the query, and the upload names the asset", async () => {
  const calls = [];
  const attachments = new StudioAttachments(async (path, init) => { calls.push({ path, init }); return { asset_id: "a-9", kind: "file", name: "n.txt", bytes: 5, state: "ready" }; });
  const file = new File(["hello"], "my notes.txt", { type: "text/plain" });
  const [ready] = await attachments.prepareAll([file]);
  assert.equal(calls[0].path, `${ROOT}/assets?name=my%20notes.txt`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "text/plain");
  assert.equal(calls[0].init.body, file, "no base64, no JSON");
  assert.deepEqual([ready.asset_id, ready.type, ready.display_name], ["a-9", "file", "my notes.txt"]);
});

test("an interrupted Run shows no error and no answer-again offer; the server's retry is followed; Stop posts to /stop", async () => {
  const { controller, state } = setup({ events: [event(1, "user.message", { id: "m1", run_id: "run_1" }), event(2, "run.state", { run_id: "run_1", status: "running" })] });
  controller.open(ASSISTANT_CONVERSATION);
  await flush();
  const until = new Date(Date.now() + 60_000).toISOString();
  state.events.push(event(3, "run.state", { run_id: "run_1", status: "interrupted" }), event(4, "run.retrying", { run_id: "run_1", until }));
  FakeSource.all[0].emit({ type: "state" });
  await flush();
  assert.equal(controller.state.error, null, "no error is shown");
  assert.equal(controller.state.failedRun, null, "no answer-again offer");
  assert.equal(controller.state.activeRun, "run_1", "still working, quietly");
  state.events.push(event(5, "run.superseded", { run_id: "run_1", by: "run_2" }), event(6, "run.state", { run_id: "run_2", status: "running" }));
  FakeSource.all[0].emit({ type: "state" });
  await flush();
  assert.equal(controller.state.activeRun, "run_2");
  assert.equal(controller.state.error, null);
  controller.cancel();
  await flush();
  assert.equal(state.sent.at(-1)?.path, `${ROOT}/stop`);
  controller.dispose();
});
