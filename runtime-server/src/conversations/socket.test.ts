import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import type { AssistantHost } from "./assistantConversation.js";
import { MemoryEventLog } from "./eventLog.js";
import { EventLogJournal } from "./journal.js";
import { StudioSockets, type Identity } from "./socket.js";
import { Studio } from "./studio.js";

// A real WebSocket server and client over the real Studio, log and follower. The Assistant host is the one explicit fake.
const TOKENS: Record<string, string> = { key1: "a1" };

async function harness() {
  const assistant = { stopped: 0, running: false, status: async () => assistant.running ? { state: "running" as const, runId: "r1" } : { state: "idle" as const }, lines: async () => [], send: async () => ({}), feedKey: () => "assistant:a1", conversationId: () => "assistant:a1", assets: () => undefined, stop: async () => { assistant.stopped++; } };
  const eventLog = new MemoryEventLog();
  // The Assistant's runtime journals its events into the log; here the test plays that runtime.
  const journal = new EventLogJournal(eventLog, () => "assistant:a1");
  const studio = new Studio({ product: async () => undefined, workspace: async () => { throw new Error("unused"); }, assistant: () => assistant as unknown as AssistantHost, eventLog });
  const sockets = new StudioSockets({ studio, pollMs: 10, identify: async token => TOKENS[token] ? { accountId: TOKENS[token]!, token } : undefined });
  const server = http.createServer();
  const clients: WebSocket[] = [];
  server.on("upgrade", (request, socket, head) => {
    const header = request.headers.authorization?.replace(/^Bearer /, "");
    const identity: Identity | undefined = header && TOKENS[header] ? { accountId: TOKENS[header]!, token: header } : undefined;
    sockets.upgrade(request, socket, head, identity);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/v1/creator/studio/ws`;
  const open = async (headers: Record<string, string> = {}) => {
    const ws = new WebSocket(url, { headers });
    clients.push(ws);
    const inbox: Array<Record<string, any>> = [];
    ws.on("message", data => inbox.push(JSON.parse(data.toString())));
    await new Promise(resolve => ws.once("open", resolve));
    const next = async (match: (message: Record<string, any>) => boolean) => { for (let i = 0; i < 200; i++) { const found = inbox.find(match); if (found) return found; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(`no message: ${JSON.stringify(inbox)}`); };
    return { ws, inbox, next, send: (value: unknown) => ws.send(JSON.stringify(value)), closed: new Promise<number>(resolve => ws.once("close", code => resolve(code))) };
  };
  const emit = (type: string, extra: Record<string, unknown> = {}) => journal.append({ sessionId: "s1", type, ...extra });
  return { assistant, open, emit, close: () => { clients.forEach(client => client.terminate()); server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("socket: an API key signs in with the first message, never in the URL; a bad one is closed", async () => {
  const h = await harness();
  try {
    const bad = await h.open();
    bad.send({ type: "auth", token: "wrong" });
    assert.equal(await bad.closed, 4401);
    const early = await h.open();
    early.send({ type: "subscribe", id: "s", target: { assistant: true }, stream: true });
    assert.equal(await early.closed, 4401, "nothing is served before sign-in");
    const good = await h.open();
    good.send({ type: "auth", token: "key1" });
    await good.next(message => message.type === "ready");
    const bearer = await h.open({ authorization: "Bearer key1" });
    await bearer.next(message => message.type === "ready");
  } finally { await h.close(); }
});

test("socket: stream true gets every event after the snapshot, stream false only results, and resume by cursor", async () => {
  const h = await harness();
  try {
    const client = await h.open({ authorization: "Bearer key1" });
    h.emit("message_end");
    await new Promise(resolve => setTimeout(resolve, 20));
    client.send({ type: "subscribe", id: "live", target: { assistant: true }, stream: true });
    client.send({ type: "subscribe", id: "quiet", target: { assistant: true }, stream: false });
    const live = await client.next(message => message.type === "snapshot" && message.id === "live");
    assert.equal(live.snapshot.cursor, "1");
    h.emit("delta", { text: "Hi" }); h.emit("message"); h.emit("run_end", { status: "completed" });
    await client.next(message => message.id === "quiet" && message.event?.type === "run_end");
    const cursors = client.inbox.filter(message => message.id === "live" && message.type === "event").map(message => [message.cursor, message.event.type]);
    assert.deepEqual(cursors, [["2", "delta"], ["3", "message"], ["4", "run_end"]], "one monotonic cursor, no gap, no duplicate");
    assert.deepEqual(client.inbox.filter(message => message.id === "quiet" && message.type === "event").map(message => message.event.type), ["message", "run_end"], "no token-level partials");
    client.ws.close();
    await client.closed;
    h.emit("delta", { text: "while away" });
    const back = await h.open({ authorization: "Bearer key1" });
    back.send({ type: "subscribe", id: "again", target: { assistant: true }, after: "4", stream: true });
    const resumed = await back.next(message => message.type === "event");
    assert.deepEqual([resumed.cursor, resumed.event.text], ["5", "while away"], "resumes by cursor, with no snapshot");
    assert.equal(back.inbox.some(message => message.type === "snapshot"), false);
    back.send({ type: "subscribe", id: "bad", target: { assistant: true }, after: "99", stream: true });
    assert.equal((await back.next(message => message.type === "error")).error.code, "invalid_cursor");
    assert.equal(h.assistant.stopped, 0, "closing every client never stopped the Run");
  } finally { await h.close(); }
});
