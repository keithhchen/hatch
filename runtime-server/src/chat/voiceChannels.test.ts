import assert from "node:assert/strict";
import { test } from "node:test";
import { saying } from "../assets/kit.test.js";
import type { ChannelConnection } from "../channels/connections.js";
import type { Inbound } from "../channels/ports.js";
import { ProductTarget } from "../channels/productTarget.js";
import type { ChannelAdapter, InboundEvent } from "../channels/types.js";
import type { ChatGateway, SentMessage } from "./gateway.js";
import { alice, creatorId, ended, productId, withFixture, type Fixture } from "./kit.test.js";

/** What every platform's voice adapter hands over: a file the adapter can download. The bytes only need to be Ogg to be audio here. */
const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]);
const connection: ChannelConnection = { id: "conn-1", ownerAccountId: creatorId, channel: "whatsapp", scope: "", client: "im", target: { kind: "product", productId }, audience: "public", taskSpecific: false, state: "active" };
const voice: InboundEvent = { eventId: "wamid.V1", address: { threadId: "W1:PN1:alice", senderId: "alice" }, file: { ref: "W1:1234", name: "voice.ogg", size: 60 } };

/** Our ProductTarget in front of the real Chat gateway, the way a channel adapter's event reaches it. */
function receiving({ runtime }: Fixture) {
  const sent: SentMessage[] = [];
  const notices: string[] = [];
  const gateway: ChatGateway = { send: async (...args) => { const result = await runtime.chat.send(...args); sent.push(result); return result; }, upload: (...args) => runtime.chat.upload(...args), progress: runId => runtime.chat.progress(runId) };
  const target = new ProductTarget({ gateway, limiter: { take: async () => 0 } });
  const adapter = { maxFileBytes: 20 * 1024 * 1024, download: async () => ogg } as unknown as ChannelAdapter;
  const handle = (event: InboundEvent) => target.handle({ id: event.eventId, connection, principal: alice, address: { connectionId: connection.id, ...event.address }, event, adapter, notify: async text => { notices.push(text); } } as Inbound);
  return { handle, sent, notices };
}

test("a voice message from any channel reaches the conversation as its transcript, text in the history", () => withFixture({ assets: true, moderator: { transcriber: saying("book me a table for two") } }, async fixture => {
  const { handle, sent, notices } = receiving(fixture);
  const handled = await handle(voice);
  assert.equal(handled.replied, false);
  assert.deepEqual(notices, []);
  assert.equal((await ended(fixture.runtime.chat, handled.runId!)).status, "completed");
  assert.equal(fixture.seen.at(-1)!.at(-1)!.content, "book me a table for two");
  // What a web view of the conversation reads: the transcript as the user's message.
  const history = await fixture.store.readVisibleConversation(sent[0]!.conversationId);
  assert.deepEqual(history.filter(message => message.role === "user").map(message => message.content), ["book me a table for two"]);
  // The platform delivers the same voice message again: the same message and Run.
  assert.equal((await handle(voice)).runId, handled.runId);
  assert.equal(sent.length, 2);
}));

test("a voice message that cannot be transcribed is answered at once with a fixed message, and starts no Run", () => withFixture({ assets: true, moderator: { transcriber: { async transcribe() { return { status: "unavailable", reason: "Gemini 429 quota exceeded, key AIzaSyEXAMPLE" }; } } } }, async fixture => {
  const { handle, sent, notices } = receiving(fixture);
  const log = console.error;
  console.error = () => undefined;
  try { assert.deepEqual(await handle(voice), { replied: true }); } finally { console.error = log; }
  assert.deepEqual(notices, ["Voice messages cannot be transcribed right now. Please send text instead."]);
  assert.deepEqual(sent, []);
}));

test("a voice message with no speech in it is answered with that, not with silence", () => withFixture({ assets: true, moderator: { transcriber: saying("  ") } }, async fixture => {
  const { handle, sent, notices } = receiving(fixture);
  assert.deepEqual(await handle(voice), { replied: true });
  assert.deepEqual(notices, ["No speech was recognized in that voice message."]);
  assert.deepEqual(sent, []);
}));
