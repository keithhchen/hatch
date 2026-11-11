import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AttachmentFiles } from "../assets/files.js";
import { harness, png } from "../assets/kit.test.js";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import { createRuntimeServer, type RuntimeServer } from "../index.js";
import type { ConversationMessage } from "../protocol.js";
import { RuntimeStore, localRuntimeAuthority } from "../store.js";
import { ChatAssets, assetScopeOf, attachmentMessageId } from "./assets.js";
import { withinImageBudget } from "./imageBudget.js";
import { principalKey } from "./principal.js";
import { sniff } from "../assets/sniff.js";

const box = (type: string, ...body: Buffer[]) => { const payload = Buffer.concat(body); const head = Buffer.alloc(8); head.writeUInt32BE(8 + payload.length); head.write(type, 4, "latin1"); return Buffer.concat([head, payload]); };
/** The smallest MP4 that names its handler: a video track makes it a video, an audio track a voice message. */
const mp4 = (handler: "vide" | "soun") => Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), box("moov", box("trak", box("mdia", box("hdlr", Buffer.alloc(8), Buffer.from(handler), Buffer.alloc(12)))))]);

test("an MP4 with a video track is a file, not a voice message; one with only audio stays audio", () => {
  assert.deepEqual(sniff(mp4("vide"), "download.mp4"), { kind: "file", mime: "video/mp4", ext: ".mp4" });
  assert.equal(sniff(mp4("soun"), "voice.m4a").kind, "audio");
  assert.equal(sniff(Buffer.concat([Buffer.from("1a45dfa3", "hex"), Buffer.from("V_VP9")]), "clip.webm").kind, "file");
});

test("the asset scope follows the conversation's owner, so a contact's and an account's never meet", () => {
  assert.deepEqual(assetScopeOf({ id: "c1", ownerAccountId: principalKey({ kind: "contact", connectionId: "conn-1", contactId: "alice" }) }),
    { kind: "contact", connectionId: "conn-1", contactId: "alice", conversationId: "c1" });
  assert.deepEqual(assetScopeOf({ id: "c1", ownerAccountId: "11111111-1111-4111-8111-111111111111" }),
    { kind: "account", accountId: "11111111-1111-4111-8111-111111111111", conversationId: "c1" });
  // A platform event id is safe in a path once it is derived.
  assert.match(attachmentMessageId("telegram:100/200 ../x"), /^msg_[0-9a-f]{16}$/);
  assert.equal(attachmentMessageId("e1"), attachmentMessageId("e1"));
});

const message = (label: string, bytes: number, labelled = true): ConversationMessage => ({
  role: "user", content: labelled ? `[image: /attachments/m/${label}.png]` : "an image with no label",
  model_images: [{ type: "image", mimeType: "image/png", data: Buffer.alloc(bytes).toString("base64") }]
});

test("the oldest images leave the model's view first, the newest stays, and only a labelled image can go", () => {
  const history = [message("a", 600), message("b", 600), message("c", 600)];
  const fitted = withinImageBudget(history, 1500);
  assert.deepEqual(fitted.map((entry) => entry.model_images?.length), [0, 1, 1]);
  assert.match(fitted[0]!.content!, /\[image: \/attachments\/m\/a\.png\]/, "its path label stays in the text");
  assert.equal(history[0]!.model_images!.length, 1, "the stored history is not touched");
  assert.equal(withinImageBudget(history, 10_000), history);
  // The newest is kept even when it alone is over the budget.
  assert.deepEqual(withinImageBudget([message("a", 600), message("b", 5000)], 100).map((entry) => entry.model_images?.length), [0, 1]);
  // An image the text does not name cannot be replaced by a label, so it is never dropped.
  assert.deepEqual(withinImageBudget([message("a", 600, false), message("b", 600)], 700).map((entry) => entry.model_images?.length), [1, 1]);
});

// ── The Chat API over HTTP: the same pipeline and scope as the channel path ──

const binding = {
  creator_id: "22222222-2222-4222-8222-222222222222",
  user_id: "11111111-1111-4111-8111-111111111111",
  agent_id: "33333333-3333-4333-8333-333333333333",
  product_id: "33333333-3333-4333-8333-333333333333",
  corpus_digest: `sha256:${"b".repeat(64)}`
};

async function httpFixture(withAssets: boolean) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-chat-http-"));
  const kit = await harness();
  const seen: ConversationMessage[] = [];
  const runtime: RuntimeServer = createRuntimeServer({
    conversationStore: new RuntimeStore(dataDir),
    conversationRepository: new InMemoryConversationRepository(localRuntimeAuthority(dataDir)),
    ...(withAssets ? { chatAssets: new ChatAssets({ pipeline: kit.pipeline, blobs: kit.blobs, files: new AttachmentFiles(kit.repository, kit.blobs) }) } : {}),
    createRuntime: () => ({ async *run(input, ctx) {
      seen.push(...ctx.messages);
      yield { type: "assistant.delta" as const, run_id: input.run_id, delta: { kind: "text" as const, content: "seen" } };
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } })
  });
  await new Promise<void>((resolve) => (runtime.server as http.Server).listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${((runtime.server as http.Server).address() as { port: number }).port}`;
  const scope = new URLSearchParams(binding).toString();
  const call = async (route: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${route}${route.includes("?") ? "&" : "?"}${scope}`, init);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const conversation = (await call("/v1/conversations", { method: "POST", body: JSON.stringify({ client_request_id: "c1" }) })).body.conversation.id as string;
  return { runtime, call, conversation, seen };
}

test("upload a file to a conversation, then send it by assetId: one pipeline for every client", async () => {
  const { runtime, call, conversation, seen } = await httpFixture(true);
  try {
    const uploaded = await call(`/v1/conversations/${conversation}/assets?name=photo.png`, { method: "POST", body: new Blob([new Uint8Array(await png(16, 16))]) });
    assert.equal(uploaded.status, 201);
    assert.deepEqual([uploaded.body.kind, uploaded.body.name, uploaded.body.state], ["image", "photo.png", "ready"]);
    const sent = await call(`/v1/conversations/${conversation}/messages?wait=5`, { method: "POST", body: JSON.stringify({ client_message_id: "m1", parts: [{ type: "text", text: "what is this?" }, { type: "image", assetId: uploaded.body.asset_id }] }) });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.reply, "seen");
    const user = seen.find((entry) => entry.role === "user")!;
    assert.match(user.content!, /^what is this\?\n\[image: \/attachments\/msg_[0-9a-f]{16}\/photo\.png\]$/);
    assert.equal(user.model_images?.length, 1);
    // The same message again is the same Run.
    const again = await call(`/v1/conversations/${conversation}/messages?wait=5`, { method: "POST", body: JSON.stringify({ client_message_id: "m1", parts: [{ type: "text", text: "what is this?" }, { type: "image", assetId: uploaded.body.asset_id }] }) });
    assert.deepEqual([again.body.outcome, again.body.run.id], ["replayed", sent.body.run.id]);
    // Refusals: no name, an empty file, an unknown asset, another conversation.
    assert.equal((await call(`/v1/conversations/${conversation}/assets`, { method: "POST", body: "x" })).body.error.code, "invalid_upload");
    assert.equal((await call(`/v1/conversations/${conversation}/assets?name=a.txt`, { method: "POST", body: "" })).body.error.code, "invalid_upload");
    const unknown = await call(`/v1/conversations/${conversation}/messages`, { method: "POST", body: JSON.stringify({ client_message_id: "m2", parts: [{ type: "image", assetId: "nope" }] }) });
    assert.deepEqual([unknown.status, unknown.body.error.code], [404, "asset_not_found"]);
    assert.equal((await call(`/v1/conversations/${conversation}/assets?name=a.txt`, { method: "GET" })).status, 405);
  } finally { await runtime.close(); }
});

test("without an asset service the Chat API refuses uploads and attachments, never dropping them", async () => {
  const { runtime, call, conversation } = await httpFixture(false);
  try {
    assert.deepEqual((await call(`/v1/conversations/${conversation}/assets?name=a.txt`, { method: "POST", body: "x" })).body.error.code, "attachments_unavailable");
    const sent = await call(`/v1/conversations/${conversation}/messages`, { method: "POST", body: JSON.stringify({ client_message_id: "m1", parts: [{ type: "file", assetId: "x" }] }) });
    assert.deepEqual([sent.status, sent.body.error.code], [501, "attachments_unavailable"]);
    // Text parts still work.
    assert.equal((await call(`/v1/conversations/${conversation}/messages?wait=5`, { method: "POST", body: JSON.stringify({ client_message_id: "m2", parts: [{ type: "text", text: "hi" }] }) })).body.reply, "seen");
  } finally { await runtime.close(); }
});

test("a video and a screenshot sent together both reach the model's message, each labelled", async () => {
  const { runtime, call, conversation, seen } = await httpFixture(true);
  try {
    const upload = async (name: string, bytes: Buffer) => (await call(`/v1/conversations/${conversation}/assets?name=${name}`, { method: "POST", body: new Blob([new Uint8Array(bytes)]) })).body;
    const video = await upload("download.mp4", mp4("vide"));
    const shot = await upload("Screenshot.png", await png(16, 16));
    assert.deepEqual([video.kind, video.state], ["file", "ready"], JSON.stringify(video));
    const parts = [{ type: "text", text: "你看看" }, { type: video.kind, assetId: video.asset_id }, { type: shot.kind, assetId: shot.asset_id }];
    const sent = await call(`/v1/conversations/${conversation}/messages?wait=5`, { method: "POST", body: JSON.stringify({ client_message_id: "m1", parts }) });
    assert.equal(sent.status, 200);
    const user = seen.find((entry) => entry.role === "user")!;
    assert.match(user.content!, /^你看看\n\[file: download\.mp4 \| video\/mp4 \| [^\]]+ \| \/attachments\/msg_[0-9a-f]{16}\/download\.mp4\]\n\[image: \/attachments\/msg_[0-9a-f]{16}\/Screenshot\.png\]$/);
    assert.equal(user.model_images?.length, 1);
  } finally { await runtime.close(); }
});
