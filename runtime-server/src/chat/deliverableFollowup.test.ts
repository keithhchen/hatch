import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryProductCapabilities } from "../agentBox/capabilities.js";
import { InMemoryConversationRepository, type ConversationRunRecord } from "../conversationRepository.js";
import { LocalRuntimeAuthority } from "../store.js";
import { endingOf } from "../testSupport.js";
import { clientMessageInputDigest } from "../protocol.js";
import { ChatService, RunRegistry } from "./chatService.js";
import { DELIVERABLE_HTML_CAPABILITY, DeliverableFollowups, MAX_DELIVERABLE_FOLLOWUPS, deliverableFollowupKey } from "./deliverableFollowup.js";
import { RunEventHub } from "./runEventHub.js";
import { RunTerminator } from "./runTerminator.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "product", productId: "product", corpusDigest: "corpus" };
const id = "conversation:scope:audit";

async function setup(options: { capable?: boolean; page?: { published: boolean } } = {}) {
  const repository = new InMemoryConversationRepository(new LocalRuntimeAuthority());
  await repository.createConversation({ ...binding, id, publicId: "audit" });
  const hub = new RunEventHub();
  const service = new ChatService<object>({
    repository, terminator: new RunTerminator(repository, hub),
    supervisor: { adopt: () => undefined, executorId: "exec", holdsConversation: () => false, steered: () => undefined },
    hub, admission: { reserve: () => () => undefined }, registry: new RunRegistry<object>()
  });
  const page = options.page ?? { published: false };
  const followups = new DeliverableFollowups({
    capabilities: new InMemoryProductCapabilities(options.capable === false ? [] : [["product", DELIVERABLE_HTML_CAPABILITY]]),
    repository,
    hasPage: async () => page.published,
    prompts: { get: async () => "Please publish the HTML report." },
    start: async (conversation, key, content) => service.submit({
      principal: { kind: "account", accountId: "owner" } as never, conversation, scope: {}, client: { client: "web" },
      clientMessageId: key, message: async () => ({ role: "user", content }), digest: clientMessageInputDigest({ content }),
      runId: `run-${key}`, corpusDigest: "corpus", requiresLocalTools: false, mode: "start_only"
    })
  });
  /** A Run of the buyer's own message that completed. */
  const completedRun = async (n: number): Promise<ConversationRunRecord> => {
    const { run } = await repository.acceptSubmission({
      binding, run: { id: `run-${n}`, conversationId: id, clientMessageId: `m-${n}`, inputDigest: `d-${n}`, corpusDigest: "corpus", executorId: "exec" },
      canonicalUser: { role: "user", content: `question ${n}` }
    });
    return (await repository.endRun(run.id, endingOf("completed"))).run;
  };
  return { repository, followups, page, completedRun };
}

test("a Run that ends with no page published is followed by one request to publish it, in the conversation", async () => {
  const { repository, followups, completedRun } = await setup();
  const run = await completedRun(1);
  await followups.afterReply(run);
  const runs = await repository.listRuns(id);
  assert.equal(runs.length, 2);
  assert.equal(runs[1]!.clientMessageId, deliverableFollowupKey(run.id));
});

test("a Run that ends with the page published is not followed up", async () => {
  const { repository, followups, completedRun } = await setup({ page: { published: true } });
  await followups.afterReply(await completedRun(1));
  assert.equal((await repository.listRuns(id)).length, 1);
});

test("a Product without the deliverable_html capability is not followed up", async () => {
  const { repository, followups, completedRun } = await setup({ capable: false });
  await followups.afterReply(await completedRun(1));
  assert.equal((await repository.listRuns(id)).length, 1);
});

test(`IDEMPOTENT: the same Run's end delivered many times, from any instance, sends one follow-up`, async () => {
  const { repository, followups, completedRun } = await setup();
  const run = await completedRun(1);
  await Promise.all([followups.afterReply(run), followups.afterReply(run), followups.afterReply(run)]);
  await followups.afterReply(run);
  assert.equal((await repository.listRuns(id)).length, 2);
});

test(`at most ${MAX_DELIVERABLE_FOLLOWUPS} follow-ups in a row, then the conversation is left alone`, async () => {
  const { repository, followups, completedRun } = await setup();
  await followups.afterReply(await completedRun(1));
  for (let round = 0; round < 3; round++) {
    const latest = (await repository.listRuns(id)).at(-1)!;
    const ended = (await repository.endRun(latest.id, endingOf("completed"))).run;
    await followups.afterReply(ended);
  }
  const runs = await repository.listRuns(id);
  assert.equal(runs.length, 1 + MAX_DELIVERABLE_FOLLOWUPS);
  assert.equal(runs.filter(run => run.clientMessageId.startsWith("deliverable-followup:")).length, MAX_DELIVERABLE_FOLLOWUPS);
});
