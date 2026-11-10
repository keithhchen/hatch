import assert from "node:assert/strict";
import test from "node:test";
import { JOURNAL_EVENT_TYPES } from "../conversationRepository.js";

// The web client validates the journal against its own list of event types; a type the server adds must be known there.
test("the client's list of journal event types is the server's", async () => {
  const client = await import(new URL("../../../packages/chat/src/domain/journal-events.js", import.meta.url).href) as { JOURNAL_EVENT_TYPES: readonly string[] };
  assert.deepEqual([...client.JOURNAL_EVENT_TYPES].sort(), [...JOURNAL_EVENT_TYPES].sort());
});
