import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntime } from "../agentRuntime.js";
import { ChatReplies } from "../channels/productTarget.js";
import { HttpChatGateway } from "../channels/runtimeChat.js";
import { alice, dm, ended, sleep, text, thread, withFixture, type Fixture } from "./kit.test.js";

/**
 * The channel layer is another process: it learns of a compaction only by asking Chat over the service API. A Run that
 * compacts twice shows two ids, each stable while it lasts, and the Run's end carries its one reply.
 */
test("a waiting channel hears each compaction once across the HTTP adapter, and the Run's end after them", () => {
  const gates: Array<() => void> = [];
  let journal: Fixture["repository"];
  const runtime: AgentRuntime = { async *run(input, ctx) {
    for (const phase of ["pre_turn", "mid_turn"] as const) {
      await ctx.state.compact(phase);
      await journal.appendEvent({ conversationId: (await journal.findRun(input.run_id))!.conversationId, runId: input.run_id, type: "compaction.started", payload: { compaction_id: `cmp_${phase}` } });
      await new Promise<void>((resolve) => gates.push(resolve));
      await ctx.state.start();
    }
    yield { type: "assistant.delta" as const, run_id: input.run_id, delta: { kind: "text" as const, content: "done" } };
    yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
  } };
  return withFixture({ runtime }, async ({ runtime: server, port, repository }) => {
    journal = repository;
    const remote = new HttpChatGateway({ baseUrl: `http://127.0.0.1:${port}`, serviceToken: "service-secret" });
    const sent = await server.chat.send(alice, thread, dm, "evt-c", text("long question"));
    const notices: string[] = [];
    const replies: string[] = [];
    const channel = new ChatReplies({
      gateway: remote,
      inbox: { byRun: async () => [{ id: "i1", connectionId: "conn-1", channel: "telegram", scope: "", event: { address: { threadId: "t1", senderId: "alice" } } }], markReplied: async () => undefined, openRuns: async () => [] } as never,
      dispatcher: { send: async (message: { message: { text: string } }) => { replies.push(message.message.text); return undefined; } } as never,
      compacting: async (_runId, compactionId) => { notices.push(compactionId); }
    });
    const settleUntilCompacting = async (not?: string) => {
      for (let waited = 0; waited < 500; waited += 1) {
        await channel.settle(sent.runId);
        const latest = notices.at(-1);
        if (latest && latest !== not) return latest;
        await sleep(20);
      }
      throw new Error("no compaction reached the channel");
    };
    const first = await settleUntilCompacting();
    await channel.settle(sent.runId);
    assert.deepEqual([...new Set(notices)], [first], "however often it asks, one compaction is one id");
    gates.shift()!();
    const second = await settleUntilCompacting(first);
    assert.notEqual(second, first, "the next compaction is another notice");
    assert.deepEqual(replies, [], "no reply while the Run is still going");
    while (gates.length) gates.shift()!();
    await ended(remote, sent.runId);
    await channel.settle(sent.runId);
    assert.deepEqual(replies, ["done"]);
    assert.deepEqual([...new Set(notices)], ["cmp_pre_turn", "cmp_mid_turn"], "the ids are the durable compaction ids");
  });
});
