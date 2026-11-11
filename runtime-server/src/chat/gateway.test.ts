import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntime } from "../agentRuntime.js";
import { block, png, saying, wav } from "../assets/kit.test.js";
import { principalKey } from "./principal.js";
import { alice, bob, creatorId, dm, ended, gatewayFixture, owner, productId, selfThread, sleep, stranger, text, thread, withFixture, type Fixture } from "./kit.test.js";

test("the channel layer sends a customer's message and learns the Run's one reply, with no transport", () => withFixture({}, async ({ runtime }) => {
  const sent = await runtime.chat.send(alice, thread, dm, "evt-1", text("hi"));
  assert.equal(sent.outcome, "started");
  assert.deepEqual(await ended(runtime.chat, sent.runId), { runId: sent.runId, status: "completed", text: "echo: hi" });
  // The platform redelivers the event: same key, no second Run.
  const again = await runtime.chat.send(alice, thread, dm, "evt-1", text("hi"));
  assert.deepEqual([again.outcome, again.runId, again.conversationId], ["replayed", sent.runId, sent.conversationId]);
  await assert.rejects(runtime.chat.send(alice, thread, dm, "evt-1", text("changed")), { code: "client_message_conflict" });
  // The same thread of another contact is another conversation.
  const other = await runtime.chat.send(bob, thread, dm, "evt-2", text("hello"));
  assert.notEqual(other.conversationId, sent.conversationId);
  await ended(runtime.chat, other.runId);
  await assert.rejects(runtime.chat.send(bob, { kind: "conversation", id: sent.conversationId }, dm, "evt-3", text("let me in")), { code: "conversation_not_found" });
  assert.equal(await runtime.chat.progress("run_unknown"), undefined);
  // Without an asset service an attachment is refused, never dropped.
  await assert.rejects(runtime.chat.send(alice, thread, dm, "evt-4", [{ type: "image", assetId: "asset" }]), { code: "attachments_unavailable", status: 501 });
  await assert.rejects(runtime.chat.upload(alice, thread, { name: "a.txt", bytes: Buffer.from("x") }), { code: "attachments_unavailable" });
}));

test("a self Connection serves its linked account its own Product, and no one else", () => withFixture({}, async ({ runtime, repository }) => {
  const im = { client: "im" as const };
  const sent = await runtime.chat.send(owner, selfThread, im, "evt-1", text("hi"));
  assert.equal(sent.outcome, "started");
  assert.deepEqual(await ended(runtime.chat, sent.runId), { runId: sent.runId, status: "completed", text: "echo: hi" });
  assert.equal((await repository.getConversation(sent.conversationId))?.ownerAccountId, creatorId, "the conversation is the account's own");
  const again = await runtime.chat.send(owner, selfThread, im, "evt-1", text("hi"));
  assert.deepEqual([again.outcome, again.runId, again.conversationId], ["replayed", sent.runId, sent.conversationId]);
  // Another account cannot use this Connection, and a Connection linked by a non-owner of the Product does not serve it.
  await assert.rejects(runtime.chat.send(stranger, selfThread, im, "evt-2", text("hi")), { code: "connection_not_shared", status: 403 });
  await assert.rejects(runtime.chat.send(stranger, { ...selfThread, connectionId: "conn-self-other" }, im, "evt-3", text("hi")), { code: "entitlement_required", status: 403 });
  // A contact never reaches a self Connection as an account, and `public` never serves an account.
  await assert.rejects(runtime.chat.send(owner, thread, im, "evt-4", text("hi")), { code: "connection_not_shared", status: 403 });
}));

test("a contact's follow-up while a Run is active joins it, and the channel gets that Run's one reply", () => withFixture({}, async ({ runtime, repository }) => {
  const first = await runtime.chat.send(alice, thread, dm, "evt-a", text("one"));
  const second = await runtime.chat.send(alice, thread, dm, "evt-b", text("two"));
  // Whether the follow-up arrived mid-Run or just after it, no message is lost or answered twice per Run.
  const replies = [await ended(runtime.chat, first.runId), await ended(runtime.chat, second.runId)];
  assert.ok(replies.every((reply) => reply.status === "completed"));
  const runs = await repository.listRuns(first.conversationId);
  assert.ok(runs.length >= 1 && runs.length <= 2);
  assert.equal(runs.reduce((count, run) => count + 1 + run.steeredCount, 0), 2);
}));

test("a Product that needs local tools is unavailable on dm instead of silently degrading", () => withFixture({ localTools: true }, async ({ runtime, repository }) => {
  await assert.rejects(runtime.chat.send(alice, thread, dm, "evt-1", text("hi")), { code: "product_requires_local_tools" });
  await assert.rejects(runtime.chat.send(alice, thread, { client: "im" }, "evt-2", text("hi")), { code: "product_requires_local_tools" });
  assert.equal(await repository.countSentMessages({ ownerAccountId: principalKey(alice), creatorId, agentId: productId }), 0);
}));

test("a contact past its message limit is refused before any Run exists", () => withFixture({ maxMessages: 1 }, async ({ runtime }) => {
  const sent = await runtime.chat.send(alice, thread, dm, "evt-1", text("one"));
  await ended(runtime.chat, sent.runId);
  await assert.rejects(runtime.chat.send(alice, thread, dm, "evt-2", text("two")), { code: "contact_limit_reached" });
}));

test("progress names each compaction by the durable id Chat announced, so a notice is sent once per compaction and the Run's end carries its reply", () => {
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
  return withFixture({ runtime }, async ({ runtime: server, repository }) => {
    journal = repository;
    const sent = await server.chat.send(alice, thread, dm, "evt-c", text("long question"));
    const compactionOf = async () => {
      for (let waited = 0; waited < 500; waited += 1) {
        const progress = await server.chat.progress(sent.runId);
        if (progress && !progress.ended && progress.compactionId) return progress.compactionId;
        await sleep(20);
      }
      throw new Error("no compaction");
    };
    const first = await compactionOf();
    assert.equal(first, "cmp_pre_turn");
    assert.equal(await compactionOf(), first, "one compaction has one id however often it is asked");
    gates.shift()!();
    for (let waited = 0; (await compactionOf()) === first && waited < 100; waited += 1) await sleep(20);
    const second = await compactionOf();
    assert.equal(second, "cmp_mid_turn", "the next compaction is another notice");
    while (gates.length) gates.shift()!();
    assert.equal((await ended(server.chat, sent.runId)).text, "done");
  });
});

// ── Attachments ──

const asset = async (fixture: Fixture, principal: typeof alice, name: string, bytes: Buffer) => (await fixture.runtime.chat.upload(principal, thread, { name, bytes })).assetId;

test("a message refers to ready assets: pixels with a path label, one line for a file, a voice message as its transcript", () => withFixture({ assets: true, moderator: { transcriber: saying("book me a table") } }, async (fixture) => {
  const { runtime, seen } = fixture;
  const image = await asset(fixture, alice, "photo.png", await png(40, 30));
  const file = await asset(fixture, alice, "menu.txt", Buffer.from("starter\nmain\ndessert"));
  const voice = await asset(fixture, alice, "note.wav", wav());
  const parts = [{ type: "text" as const, text: "look at these" }, { type: "image" as const, assetId: image }, { type: "file" as const, assetId: file }, { type: "audio" as const, assetId: voice }];
  const sent = await runtime.chat.send(alice, thread, dm, "evt-img", parts);
  const reply = await ended(runtime.chat, sent.runId);
  const message = seen.at(-1)!.at(-1)!;
  assert.match(message.content!, /^look at these\n\[image: \/attachments\/msg_[0-9a-f]{16}\/photo\.png\]\n\[file: menu\.txt \| text\/plain \| 20 B \| \/attachments\/msg_[0-9a-f]{16}\/menu\.txt\]\nbook me a table$/);
  assert.equal(message.model_images?.length, 1);
  assert.equal(message.model_images![0]!.mimeType, "image/png");
  assert.equal(reply.status, "completed");
  // The platform redelivers the event: the same message and Run, and nothing is attached twice.
  const again = await runtime.chat.send(alice, thread, dm, "evt-img", parts);
  assert.deepEqual([again.outcome, again.runId], ["replayed", sent.runId]);
  assert.equal((await fixture.kit.repository.listAttached({ kind: "contact", connectionId: "conn-1", contactId: "alice", conversationId: sent.conversationId })).length, 3);
}));

test("an asset belongs to one contact in one conversation and may join any number of its messages", () => withFixture({ assets: true }, async (fixture) => {
  const { runtime } = fixture;
  const image = await asset(fixture, alice, "photo.png", await png());
  // Another contact cannot refer to it, even by guessing its id.
  await assert.rejects(runtime.chat.send(bob, thread, dm, "evt-b", [{ type: "image", assetId: image }]), { code: "asset_not_found", status: 404 });
  // The right kind only.
  await assert.rejects(runtime.chat.send(alice, thread, dm, "evt-k", [{ type: "file", assetId: image }]), { code: "asset_kind_mismatch" });
  await assert.rejects(runtime.chat.send(alice, thread, dm, "evt-d", [{ type: "image", assetId: image }, { type: "image", assetId: image }]), { code: "duplicate_asset" });
  const sent = await runtime.chat.send(alice, thread, dm, "evt-1", [{ type: "image", assetId: image }]);
  await ended(runtime.chat, sent.runId);
  // The same picture sent again is another message that carries it; both list it.
  const again = await runtime.chat.send(alice, thread, dm, "evt-2", [{ type: "image", assetId: image }]);
  await ended(runtime.chat, again.runId);
  const links = await fixture.kit.repository.listAttached({ kind: "contact", connectionId: "conn-1", contactId: "alice", conversationId: sent.conversationId });
  assert.deepEqual([links.length, new Set(links.map(link => link.messageId)).size], [2, 2]);
  // The same bytes uploaded again are the same asset (idempotent upload), so a retry of the upload is harmless.
  assert.equal(await asset(fixture, alice, "photo.png", await png()), image);
}));

test("a file that cannot become a ready asset is refused with the reason before any message exists", () => withFixture({ assets: true, moderator: { moderator: block("not allowed") } }, async ({ runtime }) => {
  await assert.rejects(runtime.chat.upload(alice, thread, { name: "a.txt", bytes: Buffer.from("hello") }), { code: "moderation_blocked", status: 422 });
}));

test("ls, grep and read run over the attachments of the conversation of the call, never another's", () => {
  const tooling: AgentRuntime = { async *run(input, ctx) {
    const call = async (name: string, args: Record<string, unknown>) => String((await ctx.serverTools.execute(`attachments.${name}`, args)).output);
    const out = [await call("ls", {}), await call("grep", { pattern: "needle", fixed: true }), await call("read", { path: String(input.message.content).match(/\/attachments\/[^\s\]|]+/)![0] })];
    yield { type: "assistant.delta" as const, run_id: input.run_id, delta: { kind: "text" as const, content: out.join("\n---\n") } };
    yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
  } };
  return withFixture({ assets: true, runtime: tooling }, async (fixture) => {
    const { runtime } = fixture;
    const file = await asset(fixture, alice, "notes.txt", Buffer.from("hay\nthe needle is here\nhay"));
    const sent = await runtime.chat.send(alice, thread, dm, "evt-t", [{ type: "file", assetId: file }]);
    const reply = (await ended(runtime.chat, sent.runId)).text;
    assert.match(reply, /notes\.txt/);
    assert.match(reply, /:2: the needle is here/);
    assert.match(reply, /"content":"hay\\nthe needle is here\\nhay"/);
    // Bob uploads nothing, so he sees nothing of Alice's file: the scope is the conversation's owner.
    const bobFile = await asset(fixture, bob, "other.txt", Buffer.from("something else"));
    const bobSent = await runtime.chat.send(bob, thread, dm, "evt-u", [{ type: "file", assetId: bobFile }]);
    const bobReply = (await ended(runtime.chat, bobSent.runId)).text;
    assert.ok(!bobReply.includes("needle"));
    assert.match(bobReply, /No matches/);
  });
});
