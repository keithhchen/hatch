import assert from "node:assert/strict";
import test from "node:test";
import { ConversationController } from "@hatch/chat";
import { ASSISTANT_CONVERSATION, SessionPendingStore, StudioAssistantTransport, StudioAttachments, wireEventsOf } from "./studioAssistantTransport.js";

const flush = () => new Promise(resolve => setImmediate(resolve));

/** An EventSource double: automated tests only. */
class FakeSource {
  constructor(url) { this.url = url; FakeSource.all.push(this); setImmediate(() => this.onopen?.()); }
  emit(event, id) { this.onmessage?.({ data: JSON.stringify(event), lastEventId: id ?? "" }); }
  close() { this.closed = true; }
}
FakeSource.all = [];

const view = (extra = {}) => ({
  has_more: false, cursor: "7", status: { state: "idle" }, partial: "", tasks: [], channels: [],
  messages: [
    { id: "message_a", role: "user", text: "hello", created_at: "2026-11-01T00:00:00Z", attachments: [{ type: "file", name: "notes.pdf", asset_id: "f1", bytes: 2048 }] },
    { id: "run_1:1", role: "assistant", text: "hi", created_at: "2026-11-01T00:00:01Z", steps: { parts: [{ type: "tool_call", tool_call_id: "t1" }, { type: "text", start: 0, end: 2 }], tool_calls: [{ tool_call_id: "t1", name: "list_agents", status: "completed" }] } },
    { id: "message_b", role: "user", text: "later", created_at: "2026-11-01T00:00:02Z", state: "queued" }
  ],
  ...extra
});

function setup(request) {
  const sent = [];
  const answer = async (path, init) => {
    if (init?.method === "POST") { sent.push({ path, key: init.headers["idempotency-key"], body: JSON.parse(init.body) }); return { run_id: "run_1", queued: false, message: {} }; }
    if (init?.method === "PUT") return { timezone: "UTC" };
    return request(path);
  };
  const transport = new StudioAssistantTransport(answer, { stream: url => new FakeSource(url), timeZone: "UTC" });
  const store = new SessionPendingStore(() => ({ getItem: () => store.raw ?? null, setItem: (_key, value) => { store.raw = value; } }));
  const controller = new ConversationController({ transport, attachments: new StudioAttachments(answer), tools: { localTools: [], prepareRun: async () => {}, cancel() {} }, pendingStore: store, pollMs: 60_000, reconnectAttempts: 0 });
  return { transport, controller, sent, store };
}

test("the page's snapshot reads as a conversation page: stable ids, run ids, steps, attachments, the cursor", async () => {
  const { transport } = setup(async () => view({ status: { state: "running", runId: "run_2" }, run_id: "run_2", partial: "so far" }));
  const page = await transport.snapshot();
  assert.deepEqual(page.messages.map(message => [message.id, message.role, message.run_id, message.state]), [["message_a", "user", undefined, undefined], ["run_1:1", "assistant", "run_1", undefined], ["message_b", "user", undefined, "queued"]]);
  assert.deepEqual(page.messages[0].attachments, [{ attachment_id: "f1", asset_id: "f1", display_name: "notes.pdf", media_type: "application/octet-stream", source_bytes: 2048 }]);
  assert.equal(page.messages[1].tool_calls[0].tool_call_id, "t1");
  assert.equal(page.cursor, 7);
  assert.deepEqual(page.runs, [{ id: "run_2", status: "running", partial_output: "so far" }]);
  assert.equal(transport.getView().tasks.length, 0);
});

test("the view's tasks and channels reach the page, and a failed Run is listed with why it failed", async () => {
  const failure = { code: "upstream_error", message: "The model is unavailable." };
  const { transport } = setup(async () => view({ status: { state: "failed", runId: "run_3", error: failure }, tasks: [{ id: "t1", status: "needs_you" }], channels: [{ kind: "lark", own_app: true }] }));
  const page = await transport.snapshot();
  assert.deepEqual(page.runs, [{ id: "run_3", status: "failed", failure }]);
  assert.deepEqual(await transport.run(ASSISTANT_CONVERSATION, "run_3"), { id: "run_3", status: "failed", failure });
  assert.deepEqual([transport.getView().tasks[0].id, transport.getView().channels[0].kind], ["t1", "lark"]);
});

test("the page reads the view from the conversation API and tells it the timezone once, by PUT", async () => {
  const calls = [];
  const transport = new StudioAssistantTransport(async (path, init) => { calls.push([init?.method ?? "GET", path, init?.body]); return view(); }, { stream: url => new FakeSource(url), timeZone: "Asia/Shanghai" });
  await transport.snapshot();
  await transport.snapshot();
  assert.deepEqual(calls.filter(([method]) => method === "PUT"), [["PUT", "/v1/creator/assistant/conversation/timezone", JSON.stringify({ timezone: "Asia/Shanghai" })]]);
  assert.deepEqual(calls.filter(([method]) => method === "GET").map(([, path]) => path), ["/v1/creator/assistant/conversation/view", "/v1/creator/assistant/conversation/view"]);
});

test("older messages are read with before=<before_cursor>, and the picture of an attachment is the conversation's asset", async () => {
  const calls = [];
  const transport = new StudioAssistantTransport(async path => { calls.push(path); return { messages: [{ id: "old", role: "user", text: "first", created_at: "t" }], has_more: true, before_cursor: "c0" }; }, { stream: url => new FakeSource(url), timeZone: "UTC" });
  const page = await transport.history(ASSISTANT_CONVERSATION, { beforeCursor: "a b" });
  assert.equal(calls[0], "/v1/creator/assistant/conversation/messages?before=a%20b");
  assert.deepEqual([page.messages[0].role, page.has_more, page.before_cursor], ["user", true, "c0"]);
  assert.equal(transport.assetUrl(ASSISTANT_CONVERSATION, "img 1"), "/v1/creator/assistant/conversation/assets/img%201");
});

test("the stream is resumed from the cursor the snapshot proved, and from the last event after that", async () => {
  FakeSource.all = [];
  const { transport, controller } = setup(async () => view());
  controller.open(ASSISTANT_CONVERSATION);
  await flush();
  const [stream] = FakeSource.all;
  assert.equal(stream.url, "/v1/creator/assistant/conversation/events?after_cursor=7");
  stream.emit({ type: "state" }, "9");
  assert.equal(transport.cursor, 9);
  transport.connect(ASSISTANT_CONVERSATION, { onOpen() {}, onEvent() {}, onClose() {} });
  assert.equal(FakeSource.all.at(-1).url, "/v1/creator/assistant/conversation/events?after_cursor=9");
  controller.dispose();
});

test("Studio's events are the Runtime's: words keep their offset, steps their call id, a Run's end its status", () => {
  assert.deepEqual(wireEventsOf({ type: "delta", text: "ab", offset: 5, run_id: "r" }), [{ type: "assistant.delta", run_id: "r", delta: { kind: "text", content: "ab", offset: 5 } }]);
  assert.deepEqual(wireEventsOf({ type: "tool_end", id: "t", name: "n", isError: true, run_id: "r" }).map(event => [event.tool_call_id, event.status]), [["t", "failed"]]);
  assert.equal(wireEventsOf({ type: "run_end", status: "failed", error: { code: "x", message: "m", reference: "ref" }, run_id: "r" })[0].error.reference, "ref");
  assert.deepEqual(wireEventsOf({ type: "run_end", status: "cancelled", run_id: "r" })[0].error.code, "run_cancelled");
  assert.deepEqual(wireEventsOf({ type: "message_end" }), [{ type: "conversation.changed", committed: "assistant" }]);
});

test("a message goes out under its own key as Idempotency-Key, files first, and a reload sends the same key again", async () => {
  FakeSource.all = [];
  const { controller, sent, store } = setup(async () => view({ messages: [], cursor: "1" }));
  controller.open(ASSISTANT_CONVERSATION);
  await flush();
  controller.setDraft("one");
  await controller.send();
  controller.setDraft("one");
  await controller.send();
  await flush();
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].key, sent[1].key, "the same words twice are two messages");
  assert.equal(sent[0].path, "/v1/creator/assistant/conversation/messages");
  assert.equal(sent[0].body.content, "one");
  controller.dispose();

  // A message the server never acknowledged survives in session storage and is sent again after a reload.
  store.save({ conversationId: ASSISTANT_CONVERSATION, clientMessageId: "message_lost", content: "before reload", attachments: [{ asset_id: "a", type: "image" }] });
  const reloaded = setup(async () => view({ messages: [], cursor: "1" }));
  reloaded.store.raw = store.raw;
  reloaded.controller.open(ASSISTANT_CONVERSATION);
  await flush();
  await flush();
  assert.deepEqual(reloaded.sent.map(entry => [entry.key, entry.body.content]), [["message_lost", [{ type: "text", text: "before reload" }, { type: "image", assetId: "a" }]]]);
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
  assert.equal(calls[0].path, "/v1/creator/assistant/conversation/retry");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["idempotency-key"], "retry_1");
});

test("a file goes up as its own bytes with its name in the query, and the upload names the asset", async () => {
  const calls = [];
  const attachments = new StudioAttachments(async (path, init) => { calls.push({ path, init }); return { asset_id: "a-9", kind: "file", name: "n.txt", bytes: 5, state: "ready" }; });
  const file = new File(["hello"], "my notes.txt", { type: "text/plain" });
  const [ready] = await attachments.prepareAll([file]);
  assert.equal(calls[0].path, "/v1/creator/assistant/conversation/assets?name=my%20notes.txt");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "text/plain");
  assert.equal(calls[0].init.body, file, "no base64, no JSON");
  assert.deepEqual([ready.asset_id, ready.type, ready.display_name], ["a-9", "file", "my notes.txt"]);
});
