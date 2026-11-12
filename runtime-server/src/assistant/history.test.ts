import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileWorkbenchBackend, WorkbenchStore } from "../factoryAgents/store.js";
import { RuntimeStore } from "../store.js";
import type { AssistantStateRepository } from "./state.js";
import { LegacyAssistantHistory } from "./history.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "conv-1";

test("A crash in the middle of the history import loses nothing: the re-run appends the missing tail once, and only then is the old session wiped", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-history-"));
  try {
    const legacy = new FileWorkbenchBackend(path.join(root, "assistant"));
    const old = new WorkbenchStore(legacy, undefined, undefined);
    const session = await old.create("assistant", "Hatch 助理");
    const user = (text: string, itemId: string) => ({ role: "user" as const, content: text, timestamp: 1000, origin: { kind: "expert" as const, itemId, text } });
    const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 2000 } as never);
    await old.update(session.id, s => { s.messages = [user("一", "a"), reply("甲"), reply("乙"), user("二", "b"), reply("丙")]; });

    const real = new RuntimeStore(path.join(root, "chat"));
    let appends = 0;
    let crashAfter = 2;
    const store = { readEvents: () => real.readEvents(), append: async (event: Parameters<RuntimeStore["append"]>[0]) => { if (appends++ >= crashAfter) throw new Error("crash"); await real.append(event); } };
    const state = { expertSpoke: async () => {} } as unknown as AssistantStateRepository;
    const history = new LegacyAssistantHistory({ backend: () => legacy, state, store });

    await assert.rejects(history.importInto(ACCOUNT, CONVERSATION), /crash/);
    assert.equal((await old.get(session.id)).messages.length, 5, "the old session is untouched until the import completes");
    assert.equal((await real.readConversation(CONVERSATION)).length, 2);

    crashAfter = Infinity;
    await history.importInto(ACCOUNT, CONVERSATION);
    assert.deepEqual((await real.readConversation(CONVERSATION)).map(message => message.content), ["一", "甲", "乙", "二", "丙"]);
    assert.equal((await old.get(session.id)).messages.length, 0);
    await real.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
