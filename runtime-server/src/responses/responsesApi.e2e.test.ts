// Test fixtures only: the model, the Registry's account verification and the Product catalog are doubles; the Runtime,
// its chat domain, its repository and its HTTP adapter are the real ones, driven by the official `openai` package.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import OpenAI from "openai";
import type { AgentCorpus, AgentCorpusResolverLike } from "../agentCorpus.js";
import type { AgentRuntime } from "../agentRuntime.js";
import { AttachmentFiles } from "../assets/files.js";
import { harness, png } from "../assets/kit.test.js";
import { ChatAssets } from "../chat/assets.js";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import type { AuthIdentity, AuthIdentityResolver } from "../entitlements.js";
import { createRuntimeServer, type RuntimeServer } from "../index.js";
import { RuntimeStore } from "../store.js";
import { useSearchFixture } from "../searchFixture.testkit.js";

useSearchFixture();

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "99999999-9999-4999-8999-999999999999";
const PRODUCT = "33333333-3333-4333-8333-333333333333";
const BRIEFED = "44444444-4444-4444-8444-444444444444";
const FOREIGN = "55555555-5555-4555-8555-555555555555";
const KEY = "hatch_test_key_owner";

const corpusOf = (productId: string, creatorId: string, name: string, brief = false) => ({
  root: "", digest: `sha256:${"b".repeat(64)}`,
  corpus: {
    agent_id: productId, creator: { id: creatorId, name: "Ada Creator" },
    product: {
      id: productId, name, description: `${name} description`, boundaries: [], presentation: {},
      ...(brief ? { brief_spec: { contract_version: "1", fields: [{ id: "goal", label: "What is the goal?", required: true }, { id: "notes", label: "Notes", required: false }] } } : {})
    },
    knowledge: { documents: [] }, tools: [{ id: "hatch.web", kind: "builtin" }]
  } as unknown as AgentCorpus
});
const CORPORA = new Map([[PRODUCT, corpusOf(PRODUCT, OWNER, "Plain Agent")], [BRIEFED, corpusOf(BRIEFED, OWNER, "Briefed Agent", true)], [FOREIGN, corpusOf(FOREIGN, STRANGER, "Foreign Agent")]]);

const corpora: AgentCorpusResolverLike = {
  resolve: async (_creator, product) => CORPORA.get(String(product))!,
  resolveByProduct: async (product) => CORPORA.get(product) ?? Promise.reject(new Error(`No current Agent Corpus exists for Product ${product}`)),
  list: async (creator) => [...CORPORA.values()].filter((entry) => entry.corpus.creator.id === creator)
};

const runtimes: RuntimeServer[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((server) => server.close())); });

type Gate = { open(): void; wait: Promise<void> };
const gate = (): Gate => { let open!: () => void; const wait = new Promise<void>((resolve) => { open = resolve; }); return { open, wait }; };

async function fixture(options: { holdMs?: number; keepAliveMs?: number; assets?: boolean } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-responses-api-"));
  const store = new RuntimeStore(dataDir);
  const repository = new InMemoryConversationRepository(store.localAuthority);
  let verifications = 0;
  const identities: AuthIdentityResolver = {
    async resolveIdentity(token): Promise<AuthIdentity | undefined> {
      verifications += 1;
      if (token === KEY) return { sub: OWNER, sessionId: "session-1", clientType: "api_key" };
      if (token === "hatch_test_key_stranger") return { sub: STRANGER, sessionId: "session-2", clientType: "api_key" };
      return undefined;
    }
  };
  const kit = options.assets ? await harness() : undefined;
  const chatAssets = kit ? new ChatAssets({ pipeline: kit.pipeline, blobs: kit.blobs, files: new AttachmentFiles(kit.repository, kit.blobs) }) : undefined;
  const control = { held: undefined as Gate | undefined, seen: [] as string[] };
  const model: AgentRuntime = {
    async *run(input, ctx) {
      const said = ctx.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      control.seen.push(said);
      if (said.includes("hold") && control.held) { await control.held.wait; ctx.abortSignal?.throwIfAborted(); }
      await ctx.persistModelMessage!({ role: "assistant", content: "turn", usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      await ctx.persistModelMessage!({ role: "assistant", content: "turn", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      yield { type: "assistant.delta" as const, run_id: input.run_id, delta: { kind: "text" as const, content: "Hello " } };
      yield { type: "assistant.delta" as const, run_id: input.run_id, delta: { kind: "text" as const, content: `world: ${said.split("\n")[0]}` } };
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    }
  };
  const runtime = createRuntimeServer({
    conversationStore: store, conversationRepository: repository, authIdentityResolver: identities, agentCorpusResolver: corpora,
    createRuntime: () => model, ...(chatAssets ? { chatAssets } : {}),
    responsesApi: { ...(options.holdMs ? { holdMs: options.holdMs } : {}), ...(options.keepAliveMs ? { keepAliveMs: options.keepAliveMs } : {}) }
  });
  runtimes.push(runtime);
  await new Promise<void>((resolve) => (runtime.server as http.Server).listen(0, "127.0.0.1", () => resolve()));
  const origin = `http://127.0.0.1:${((runtime.server as http.Server).address() as { port: number }).port}`;
  const client = (apiKey = KEY) => new OpenAI({ baseURL: `${origin}/responses/v1`, apiKey, maxRetries: 0 });
  return { origin, client, store, repository, control, verifications: () => verifications, openai: client() };
}

/** The error the SDK raises for a refused request, as the shape the API promises. */
async function refused(call: Promise<unknown>): Promise<{ status: number; code: string | null; param: string | null; type: string | null }> {
  try { await call; } catch (error) {
    assert.ok(error instanceof OpenAI.APIError, `expected an APIError, got ${String(error)}`);
    const e = error as InstanceType<typeof OpenAI.APIError> & { code?: string | null; param?: string | null; type?: string };
    return { status: e.status!, code: e.code ?? null, param: e.param ?? null, type: e.type ?? null };
  }
  assert.fail("the request was accepted");
}

const eventually = async <T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 5_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

test("models: the caller's live Products are models; others are not found", async () => {
  const { openai } = await fixture();
  const listed = await openai.models.list();
  assert.deepEqual(listed.data.map((model) => model.id).sort(), [`hatch:${PRODUCT}`, `hatch:${BRIEFED}`].sort());
  const briefed = await openai.models.retrieve(`hatch:${BRIEFED}`) as unknown as { owned_by: string; name: string; task_brief: { fields: Array<{ id: string; required: boolean }> } | null };
  assert.equal(briefed.owned_by, "Ada Creator");
  assert.deepEqual(briefed.task_brief?.fields.map((field) => [field.id, field.required]), [["goal", true], ["notes", false]]);
  assert.equal(((await openai.models.retrieve(PRODUCT)) as unknown as { task_brief: unknown }).task_brief, null, "the bare product id is accepted");
  for (const model of [`hatch:${FOREIGN}`, "hatch:77777777-7777-4777-8777-777777777777", "gpt-4o"]) {
    assert.deepEqual(await refused(openai.models.retrieve(model)), { status: 404, code: "model_not_found", param: null, type: "not_found_error" });
  }
});

test("a bad or missing key is 401 invalid_api_key, a good one is cached for a moment, and every answer echoes x-request-id", async () => {
  const { client, origin, verifications } = await fixture();
  assert.deepEqual(await refused(client("hatch_wrong").models.list()), { status: 401, code: "invalid_api_key", param: null, type: "authentication_error" });
  const bare = await fetch(`${origin}/responses/v1/models`, { headers: { "x-request-id": "req_from_caller" } });
  assert.equal(bare.status, 401);
  assert.equal(bare.headers.get("x-request-id"), "req_from_caller");
  assert.deepEqual((await bare.json() as { error: Record<string, unknown> }).error.code, "invalid_api_key");
  const before = verifications();
  for (let n = 0; n < 5; n++) await client().models.list();
  assert.ok(verifications() - before <= 2, `five requests with one key verified it ${verifications() - before} times`);
});

test("conversations: create with a Task Brief, refuse a missing required field, get, update the title, list, archive", async () => {
  const { openai, origin } = await fixture();
  const post = (body: unknown) => openai.post("/conversations", { body }) as Promise<Record<string, any>>;
  const created = await post({ model: `hatch:${BRIEFED}`, task_brief: { goal: "Plan a launch" }, metadata: { title: "Launch" } });
  assert.match(created.id, /^conv_/);
  assert.equal(created.object, "conversation");
  assert.equal(created.model, `hatch:${BRIEFED}`);
  assert.deepEqual(created.metadata, { title: "Launch" });
  assert.deepEqual(created.task_brief.fields.map((field: { id: string; value: string | null }) => [field.id, field.value]), [["goal", "Plan a launch"], ["notes", null]]);

  assert.deepEqual(await refused(post({ model: `hatch:${BRIEFED}` })), { status: 400, code: "task_brief_required", param: "task_brief.goal", type: "invalid_request_error" });
  assert.deepEqual(await refused(post({ model: `hatch:${BRIEFED}`, task_brief: { goal: "x", nope: "y" } })), { status: 400, code: "invalid_task_brief", param: "task_brief.nope", type: "invalid_request_error" });
  assert.deepEqual(await refused(post({ model: `hatch:${PRODUCT}`, task_brief: { goal: "x" } })), { status: 400, code: "invalid_task_brief", param: "task_brief", type: "invalid_request_error" });
  assert.deepEqual(await refused(post({ model: `hatch:${PRODUCT}`, items: [{ role: "user", content: "hi" }] })), { status: 400, code: "unsupported_parameter", param: "items", type: "invalid_request_error" });
  assert.deepEqual(await refused(post({ model: "hatch:nope" })), { status: 404, code: "model_not_found", param: null, type: "not_found_error" });

  const got = await openai.get(`/conversations/${created.id}`) as Record<string, any>;
  assert.equal(got.id, created.id);
  const updated = await openai.post(`/conversations/${created.id}`, { body: { metadata: { title: "Renamed" } } }) as Record<string, any>;
  assert.deepEqual(updated.metadata, { title: "Renamed" });
  assert.deepEqual(await refused(openai.post(`/conversations/${created.id}`, { body: { metadata: { colour: "red" } } })), { status: 400, code: "unsupported_parameter", param: "metadata.colour", type: "invalid_request_error" });

  const second = await post({ model: `hatch:${PRODUCT}` });
  const listed = await openai.get("/conversations?limit=1") as Record<string, any>;
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].id, second.id, "newest first");
  assert.equal(listed.has_more, true);
  const next = await openai.get(`/conversations?limit=1&after=${listed.last_id}`) as Record<string, any>;
  assert.equal(next.data[0].id, created.id);
  assert.equal(((await openai.get(`/conversations?model=hatch:${PRODUCT}`)) as Record<string, any>).data.length, 1);

  // Another account sees none of it.
  const stranger = new OpenAI({ baseURL: `${origin}/responses/v1`, apiKey: "hatch_test_key_stranger", maxRetries: 0 });
  assert.deepEqual(await refused(stranger.get(`/conversations/${created.id}`)), { status: 404, code: "conversation_not_found", param: null, type: "not_found_error" });
  assert.equal(((await stranger.get("/conversations")) as Record<string, any>).data.length, 0);

  assert.deepEqual(await openai.delete(`/conversations/${created.id}`), { id: created.id, object: "conversation.deleted", deleted: true });
  assert.equal(((await openai.get("/conversations")) as Record<string, any>).data.length, 1, "an archived conversation leaves the list");
  assert.deepEqual(await refused(openai.responses.create({ conversation: created.id, input: "more" })), { status: 409, code: "conversation_archived", param: null, type: "conflict_error" });
});

test("responses: a plain request holds until the run ends and reports usage summed over its model calls", async () => {
  const { openai } = await fixture();
  const conversation = await openai.post("/conversations", { body: { model: `hatch:${PRODUCT}` } }) as { id: string };
  const response = await openai.responses.create({ model: `hatch:${PRODUCT}`, conversation: conversation.id, input: "hello there" });
  assert.equal(response.status, "completed");
  assert.match(response.id, /^resp_/);
  assert.equal(response.model, `hatch:${PRODUCT}`);
  assert.equal((response.conversation as { id: string }).id, conversation.id);
  assert.equal(response.output_text, "Hello world: hello there");
  assert.equal(response.output[0]?.type, "message");
  assert.deepEqual(response.usage, {
    input_tokens: 140, input_tokens_details: { cached_tokens: 30 }, output_tokens: 25, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 165
  });
  const again = await openai.responses.retrieve(response.id);
  assert.equal(again.status, "completed");
  assert.equal(again.output_text, response.output_text);

  const inputs = await openai.responses.inputItems.list(response.id);
  assert.deepEqual(inputs.data.map((item) => (item as { role: string }).role), ["user"]);
  const items = await openai.conversations.items.list(conversation.id, { order: "asc" } as never);
  assert.deepEqual(items.data.map((item) => (item as { role: string }).role), ["user", "assistant"]);
  assert.equal((items.data[1] as { content: Array<{ text: string }> }).content[0]?.text, "Hello world: hello there");
});

test("responses: stream emits the OpenAI event sequence with sequence numbers, and the SDK's own stream helper follows it", async () => {
  const { openai } = await fixture();
  const events: Array<{ type: string; sequence_number: number; delta?: string; response?: { status: string; output_text: string } }> = [];
  const stream = await openai.responses.create({ model: `hatch:${PRODUCT}`, input: "stream me", stream: true });
  for await (const event of stream) events.push(event as never);
  assert.deepEqual(events.map((event) => event.type), [
    "response.created", "response.in_progress", "response.output_item.added", "response.content_part.added",
    "response.output_text.delta", "response.output_text.delta", "response.output_text.done", "response.content_part.done",
    "response.output_item.done", "response.completed"
  ]);
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
  assert.equal(events.filter((event) => event.delta).map((event) => event.delta).join(""), "Hello world: stream me");
  assert.equal(events.at(-1)!.response!.status, "completed");
  assert.equal(events.at(-1)!.response!.output_text, "Hello world: stream me");

  const helper = openai.responses.stream({ model: `hatch:${PRODUCT}`, input: "again" });
  const final = await helper.finalResponse();
  assert.equal(final.output_text, "Hello world: again");
});

test("responses: a Run that is running is re-streamed from the start, and one that ended is told whole", async () => {
  const { openai, control, origin } = await fixture();
  control.held = gate();
  const started = await openai.responses.create({ model: `hatch:${PRODUCT}`, input: "hold on", background: true });
  assert.ok(["queued", "in_progress"].includes(started.status!));
  const following = fetch(`${origin}/responses/v1/responses/${started.id}?stream=true`, { headers: { authorization: `Bearer ${KEY}` } });
  const response = await following;
  assert.equal(response.headers.get("content-type")?.split(";")[0], "text/event-stream");
  await eventually(async () => control.seen.length, (n) => n > 0);
  control.held.open();
  const text = await response.text();
  assert.match(text, /^event: response\.created\n/);
  assert.match(text, /event: response\.completed\n/);
  const replay = await (await fetch(`${origin}/responses/v1/responses/${started.id}?stream=true`, { headers: { authorization: `Bearer ${KEY}` } })).text();
  assert.match(replay, /"delta":"Hello world: hold on"/);
  assert.match(replay, /event: response\.completed\n/);
});

test("responses: previous_response_id continues the conversation, and only its latest response", async () => {
  const { openai } = await fixture();
  const first = await openai.responses.create({ model: `hatch:${PRODUCT}`, input: "one" });
  const second = await openai.responses.create({ previous_response_id: first.id, input: "two" });
  assert.equal((second.conversation as { id: string }).id, (first.conversation as { id: string }).id);
  assert.equal(second.previous_response_id, first.id);
  assert.equal(second.output_text, "Hello world: two");
  assert.deepEqual(await refused(openai.responses.create({ previous_response_id: first.id, input: "branch" })), { status: 400, code: "invalid_request", param: "previous_response_id", type: "invalid_request_error" });
  assert.deepEqual(await refused(openai.responses.create({ model: `hatch:${BRIEFED}`, previous_response_id: second.id, input: "x" })), { status: 400, code: "model_conversation_mismatch", param: "model", type: "invalid_request_error" });
  assert.deepEqual(await refused(openai.responses.retrieve("resp_doesnotexist")), { status: 404, code: "response_not_found", param: null, type: "not_found_error" });
});

test("responses: a new conversation takes a Task Brief, and an empty input starts the run from it", async () => {
  const { openai } = await fixture();
  const started = await openai.responses.create({ model: `hatch:${BRIEFED}`, input: [], task_brief: { goal: "Ship it" } } as never);
  assert.equal(started.status, "completed");
  const conversation = await openai.get(`/conversations/${(started.conversation as { id: string }).id}`) as Record<string, any>;
  assert.equal(conversation.task_brief.fields[0].value, "Ship it");
  assert.deepEqual(await refused(openai.responses.create({ model: `hatch:${BRIEFED}`, input: "hi" })), { status: 400, code: "task_brief_required", param: "task_brief.goal", type: "invalid_request_error" });
  assert.deepEqual(await refused(openai.responses.create({ conversation: conversation.id, input: "hi", task_brief: { goal: "again" } } as never)), { status: 400, code: "unsupported_parameter", param: "task_brief", type: "invalid_request_error" });
  assert.deepEqual(await refused(openai.responses.create({ model: `hatch:${PRODUCT}`, input: "" })), { status: 400, code: "empty_input", param: "input", type: "invalid_request_error" });
});

test("responses: a response in progress refuses the next as 409 conversation_busy, and cancel ends it", async () => {
  const { openai, control } = await fixture();
  control.held = gate();
  const conversation = await openai.post("/conversations", { body: { model: `hatch:${PRODUCT}` } }) as { id: string };
  const busy = await openai.responses.create({ conversation: conversation.id, input: "hold this", background: true });
  assert.ok(["queued", "in_progress"].includes(busy.status!));
  assert.deepEqual(await refused(openai.responses.create({ conversation: conversation.id, input: "meanwhile" })), { status: 409, code: "conversation_busy", param: null, type: "conflict_error" });
  assert.deepEqual(await refused(openai.responses.create({ conversation: conversation.id, input: "meanwhile", stream: true })), { status: 409, code: "conversation_busy", param: null, type: "conflict_error" });
  assert.equal(control.seen.filter((said) => said.includes("meanwhile")).length, 0, "a refused message steers nothing");
  const cancelled = await openai.responses.cancel(busy.id);
  control.held.open();
  const final = await eventually(() => openai.responses.retrieve(busy.id), (response) => response.status !== "in_progress" && response.status !== "queued");
  assert.equal(final.status, "cancelled");
  assert.ok(["cancelled", "in_progress", "queued"].includes(cancelled.status!));
  // The cancelled run's executor may still be winding down: that is a busy conversation too, which passes by itself.
  let next: Awaited<ReturnType<typeof openai.responses.create>> | undefined;
  for (let attempt = 0; attempt < 100 && !next; attempt++) {
    next = await openai.responses.create({ conversation: conversation.id, input: "after" }).catch(async (error) => {
      assert.equal((error as { code?: string }).code, "conversation_busy");
      await new Promise((resolve) => setTimeout(resolve, 50));
      return undefined;
    });
  }
  assert.equal((next as { status?: string } | undefined)?.status, "completed");
});

test("responses: a request held past the limit answers in_progress, and polling finds the result", async () => {
  const { openai, control } = await fixture({ holdMs: 300 });
  control.held = gate();
  const slow = await openai.responses.create({ model: `hatch:${PRODUCT}`, input: "hold for a while" });
  assert.equal(slow.status, "in_progress");
  control.held.open();
  const done = await eventually(() => openai.responses.retrieve(slow.id), (response) => response.status === "completed");
  assert.equal(done.status, "completed");
  assert.equal(done.output_text, "Hello world: hold for a while");
});

test("a stream sends a keep-alive comment while the run is quiet", async () => {
  const { openai, control, origin } = await fixture({ keepAliveMs: 40 });
  control.held = gate();
  const response = await fetch(`${origin}/responses/v1/responses`, {
    method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: `hatch:${PRODUCT}`, input: "hold quietly", stream: true })
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let seen = "";
  const deadline = Date.now() + 5_000;
  while (!seen.includes(": keep-alive") && Date.now() < deadline) seen += new TextDecoder().decode((await reader.read()).value);
  assert.match(seen, /: keep-alive\n\n/);
  control.held.open();
  while (!(await reader.read()).done) { /* until the stream ends */ }
  void openai;
});

test("an idempotency key makes a retry the same response, and a different input under it is 409", async () => {
  const { openai, control } = await fixture();
  const first = await openai.responses.create({ model: `hatch:${PRODUCT}`, input: "once" }, { headers: { "Idempotency-Key": "key-1" } });
  const retry = await openai.responses.create({ model: `hatch:${PRODUCT}`, input: "once" }, { headers: { "Idempotency-Key": "key-1" } });
  assert.equal(retry.id, first.id, "a retry of a new conversation is the same response");
  assert.equal((retry.conversation as { id: string }).id, (first.conversation as { id: string }).id);
  assert.equal(control.seen.length, 1, "the model ran once");
  assert.deepEqual(await refused(openai.responses.create({ conversation: (first.conversation as { id: string }).id, input: "different" }, { headers: { "Idempotency-Key": "key-1" } })), { status: 409, code: "idempotency_key_reused", param: null, type: "conflict_error" });
  const next = await openai.responses.create({ previous_response_id: first.id, input: "next" }, { headers: { "Idempotency-Key": "key-2" } });
  const nextRetry = await openai.responses.create({ previous_response_id: first.id, input: "next" }, { headers: { "Idempotency-Key": "key-2" } });
  assert.equal(nextRetry.id, next.id, "a retry of a continuation is the same response");
});

test("parameters the Agent owns are refused by name, and the ones that change nothing are accepted", async () => {
  const { openai } = await fixture();
  const create = (extra: Record<string, unknown>) => openai.responses.create({ model: `hatch:${PRODUCT}`, input: "hi", ...extra } as never);
  const expectUnsupported = async (extra: Record<string, unknown>, param: string) =>
    assert.deepEqual(await refused(create(extra)), { status: 400, code: "unsupported_parameter", param, type: "invalid_request_error" });
  await expectUnsupported({ instructions: "be terse" }, "instructions");
  await expectUnsupported({ tools: [{ type: "function", name: "f", parameters: {}, strict: false }] }, "tools");
  await expectUnsupported({ tool_choice: "required" }, "tool_choice");
  await expectUnsupported({ reasoning: { effort: "low" } }, "reasoning");
  await expectUnsupported({ max_output_tokens: 50 }, "max_output_tokens");
  await expectUnsupported({ store: false }, "store");
  await expectUnsupported({ text: { format: { type: "json_object" } } }, "text.format");
  await expectUnsupported({ input: [{ role: "system", content: "x" }] }, "input[0].role");
  await expectUnsupported({ input: [{ role: "user", content: "ok" }, { role: "assistant", content: "x" }] }, "input[1].role");
  await expectUnsupported({ input: [{ role: "user", content: [{ type: "input_image", file_id: "file_123" }] }] }, "input[0].content[0].file_id");
  await expectUnsupported({ input: [{ role: "user", content: [{ type: "input_file", file_id: "file_123" }] }] }, "input[0].content[0].file_id");
  await expectUnsupported({ include: ["reasoning.encrypted_content"] }, "include[0]");
  assert.deepEqual(await refused(create({ colour: "red" })), { status: 400, code: "unknown_parameter", param: "colour", type: "invalid_request_error" });
  assert.deepEqual(await refused(openai.delete("/responses/resp_x")), { status: 400, code: "unsupported_parameter", param: "response_id", type: "invalid_request_error" });
  const accepted = await create({ temperature: 0.2, top_p: 0.9, user: "u-1", service_tier: "auto", safety_identifier: "s", prompt_cache_key: "k", tools: [], text: { format: { type: "text" } } });
  assert.equal((accepted as { status: string }).status, "completed");
});

test("an inline image goes through the shared asset path; without an asset service it is refused", async () => {
  const bytes = await png(12, 12);
  const { openai } = await fixture({ assets: true });
  const image = `data:image/png;base64,${bytes.toString("base64")}`;
  const response = await openai.responses.create({
    model: `hatch:${PRODUCT}`,
    input: [{ role: "user", content: [{ type: "input_text", text: "look at this" }, { type: "input_image", image_url: image, detail: "auto" }] }]
  });
  assert.equal(response.status, "completed");
  assert.match(response.output_text, /^Hello world: look at this/);
  const inputs = await openai.responses.inputItems.list(response.id);
  const content = (inputs.data[0] as unknown as { content: Array<{ type: string }> }).content;
  assert.deepEqual(content.map((part) => part.type), ["input_text", "input_image"]);
  assert.deepEqual(await refused(openai.responses.create({ model: `hatch:${PRODUCT}`, input: [{ role: "user", content: [{ type: "input_image", image_url: "http://example.com/a.png", detail: "auto" }] }] })), { status: 400, code: "invalid_request", param: "input[0].content[0].image_url", type: "invalid_request_error" });
  assert.equal((await refused(openai.responses.create({ model: `hatch:${PRODUCT}`, input: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${Buffer.from("not an image").toString("base64")}`, detail: "auto" }] }] }))).status, 415);

  const plain = await fixture();
  assert.equal((await refused(plain.openai.responses.create({ model: `hatch:${PRODUCT}`, input: [{ role: "user", content: [{ type: "input_image", image_url: image, detail: "auto" }] }] }))).status, 501);
});
