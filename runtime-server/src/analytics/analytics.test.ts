import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationRepository, type ConversationRunRecord } from "../conversationRepository.js";
import { ChatAnalytics } from "../chat/chatAnalytics.js";
import { ChatService, RunRegistry } from "../chat/chatService.js";
import { RunEventHub } from "../chat/runEventHub.js";
import { RunTerminator } from "../chat/runTerminator.js";
import { LocalRuntimeAuthority } from "../store.js";
import { endingOf } from "../testSupport.js";
import { emptySurfaces } from "../usage/usage.js";
import { UsageCap, UsageCapExceeded } from "../usage/usageCap.js";
import * as events from "./events.js";
import { createProductAnalytics, noopAnalytics } from "./index.js";
import { RecordingAnalytics, throwingAnalytics } from "./recording.js";
import { safely } from "./safe.js";

test("the catalog builds each event with its names and properties", () => {
  assert.deepEqual(events.agentCreated("a"), ["agent_created", { agent_id: "a" }]);
  assert.deepEqual(events.materialUploaded("a", "link", 2), ["material_uploaded", { agent_id: "a", kind: "link", count: 2 }]);
  assert.deepEqual(events.buildFailed("a", 3.5, "provider_error"), ["build_failed", { agent_id: "a", duration_s: 3.5, reason: "provider_error" }]);
  assert.deepEqual(events.messageSent("a", "im", 4), ["message_sent", { agent_id: "a", channel: "im", n: 4 }]);
  assert.deepEqual(events.usageCapReached("chat"), ["usage_cap_reached", { surface: "chat" }]);
  assert.deepEqual(events.anonymous(events.firstMessageSent("a", "im")), ["first_message_sent", { agent_id: "a", channel: "im", $process_person_profile: false }]);
  assert.deepEqual(["research", "voice", "generation", "inspiration", "content-creation"].map(events.studioStep), ["upload", "interview", "build", "inspiration", "content"]);
});

test("without a project key nothing is sent; a throwing adapter is never felt", async () => {
  assert.equal(createProductAnalytics({}), noopAnalytics);
  const safe = safely(throwingAnalytics);
  assert.doesNotThrow(() => safe.capture("u", events.agentCreated("a")));
  await safe.shutdown(10);
  assert.doesNotThrow(() => safely(undefined).capture("u", events.agentCreated("a")));
});

test("a refused run reports the cap once per refusal, with the surface that was refused", async () => {
  const recorder = new RecordingAnalytics();
  const spent = emptySurfaces();
  spent.studio_web.input = 1_000;
  const cap = new UsageCap({ monthToDate: async () => spent }, 10, { analytics: recorder });
  await assert.rejects(cap.assertWithinCap("acct"), UsageCapExceeded);
  await assert.rejects(cap.guard<{ id: string }>(scope => scope.id, "chat")({ id: "payer" }), UsageCapExceeded);
  assert.deepEqual(recorder.captured.map(entry => [entry.distinctId, entry.event, entry.props.surface]), [["acct", "usage_cap_reached", "studio"], ["payer", "usage_cap_reached", "chat"]]);
  // A broken analytics does not change the refusal.
  await assert.rejects(new UsageCap({ monthToDate: async () => spent }, 10, { analytics: throwingAnalytics }).assertWithinCap("acct"), UsageCapExceeded);
});

const binding = { ownerAccountId: "buyer", creatorId: "creator", agentId: "agent", productId: "product-1", corpusDigest: "corpus" };

async function chat(analytics: RecordingAnalytics | typeof throwingAnalytics, owner = "buyer") {
  const repository = new InMemoryConversationRepository(new LocalRuntimeAuthority());
  const { conversation } = await repository.createConversation({ ...binding, ownerAccountId: owner, id: "conv", publicId: "pub" });
  const hub = new RunEventHub(undefined, async () => 0);
  const service = new ChatService<object>({
    repository, terminator: new RunTerminator(repository, hub),
    supervisor: { adopt: () => undefined, executorId: "exec", holdsConversation: () => false, steered: () => undefined },
    hub, admission: { reserve: () => () => undefined }, registry: new RunRegistry<object>(),
    analytics: new ChatAnalytics(analytics, repository)
  });
  // Analytics counts in the background after a message is taken; a turn of the event loop lets it report.
  const say = async (n: number, client: "web" | "mcp" | "im" = "web", principal: object = { kind: "account", accountId: owner }) => {
    const submission = await service.submit({
      principal: principal as never, conversation, scope: {}, client: { client }, clientMessageId: `m-${n}`,
      message: async () => ({ role: "user", content: `q${n}` }), digest: `d-${n}`, runId: `run-${n}`, corpusDigest: "corpus", requiresLocalTools: false
    });
    await new Promise(resolve => setImmediate(resolve));
    return submission;
  };
  return { repository, hub, say, conversation };
}

test("the first message of a conversation is announced once; every message carries its index and channel", async () => {
  const recorder = new RecordingAnalytics();
  const { say } = await chat(recorder);
  await say(0, "mcp");
  await say(1, "mcp");
  await say(1, "mcp");
  assert.deepEqual(recorder.captured.map(({ distinctId, event, props }) => [distinctId, event, props.agent_id, props.channel, props.n]), [
    ["buyer", "first_message_sent", "product-1", "api", undefined],
    ["buyer", "message_sent", "product-1", "api", 0],
    ["buyer", "message_sent", "product-1", "api", 1]
  ]);
});

test("a contact is counted under its owner id with no person profile", async () => {
  const recorder = new RecordingAnalytics();
  const { say } = await chat(recorder, "contact:conn:ann");
  await say(0, "im", { kind: "contact", connectionId: "conn", contactId: "ann" });
  assert.deepEqual(recorder.captured.map(entry => [entry.distinctId, entry.event, entry.props.channel, entry.props.$process_person_profile]), [
    ["contact:conn:ann", "first_message_sent", "im", false], ["contact:conn:ann", "message_sent", "im", false]
  ]);
});

test("a broken analytics does not stop a message from being taken", async () => {
  const { say } = await chat(throwingAnalytics);
  assert.equal((await say(0)).outcome, "started");
});

test("a Run that fails tells analytics with its channel; one that completes does not", async () => {
  const recorder = new RecordingAnalytics();
  const { repository, hub, say, conversation } = await chat(recorder);
  await say(0, "web");
  const analytics = new ChatAnalytics(recorder, repository);
  const terminator = new RunTerminator(repository, hub, (ended, ending) => { if (ending.status === "failed") void analytics.runFailed(ended.run as ConversationRunRecord, ending.failure.code, { client: "web" }); });
  await terminator.end("run-0", endingOf("failed", "boom"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(recorder.captured.at(-1), { distinctId: "buyer", event: "reply_failed", props: { agent_id: conversation.productId, channel: "web", reason: "run_failed" } });
});
