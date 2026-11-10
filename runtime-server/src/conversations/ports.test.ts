import assert from "node:assert/strict";
import test from "node:test";
import type { Conversation } from "./conversation.js";
import { openConversationPorts } from "./ports.js";
import { snapshotOf } from "./snapshot.js";

test("without a database the ports report unavailability and keep nothing", async () => {
  const { eventLog } = await openConversationPorts(undefined);
  const unavailable = { status: 503, code: "conversations_unavailable" };
  await assert.rejects(eventLog.append("k", { type: "x" }), unavailable);
  await assert.rejects(eventLog.head("k"), unavailable);
  await assert.rejects(eventLog.after("k", "0"), unavailable);
  await assert.rejects(eventLog.commit("k", { type: "x" }, async () => "stored"), unavailable);
  const conversation = { feedKey: async () => "k", status: async () => ({ state: "idle" }), messages: async () => ({ status: { state: "idle" }, messages: [] }) } as unknown as Conversation;
  await assert.rejects(snapshotOf(conversation, eventLog), unavailable, "a snapshot is not made from memory");
});
