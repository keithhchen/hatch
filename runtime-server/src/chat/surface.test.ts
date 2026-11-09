import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationRepository, type ConversationRunRecord } from "../conversationRepository.js";
import type { ResolvedAgentCorpus } from "../agentCorpus.js";
import type { Connection } from "../surfaces/contract.js";
import { chatToolsForRun } from "../agentRuntime.js";
import { ChatError, principalKey } from "./principal.js";
import { ContactBinder, SentMessageLimits } from "./contactBinding.js";
import { checkUpgrade, sessionTokenFromCookie } from "./originPolicy.js";
import { throttled, withPartialOutput } from "./partialOutput.js";
import { ReadOnlyRestartPolicy } from "./resumePolicy.js";
import { CLIENT_TOOL_NAMES, assertProductUsable, authorizeLocalToolCall, productRequiresLocalTools } from "./toolSurface.js";

test("the tool list is fixed, ordered, and names where each local tool runs", () => {
  const first = chatToolsForRun([...CLIENT_TOOL_NAMES]);
  const names = first.map((tool) => tool.function.name);
  assert.deepEqual(names, [...names].sort());
  assert.deepEqual(chatToolsForRun([...CLIENT_TOOL_NAMES].reverse()).map((tool) => tool.function.name), names);
  const fileRead = first.find((tool) => tool.function.name === "file_read")!;
  assert.match(fileRead.function.description, /Available on: desktop, cli$/);
});

test("a local tool call is authorized against the client of the latest message", () => {
  assert.deepEqual(authorizeLocalToolCall("file_read", "desktop"), { allowed: true });
  const denied = authorizeLocalToolCall("shell_exec", "im");
  assert.equal(denied.allowed, false);
  assert.equal(denied.allowed === false && denied.error.code, "tool_unsupported_on_client");
});

test("a Product that needs local tools is unavailable, not degraded, on clients without them", () => {
  const corpus = { tools: [{ kind: "http_function" }, { kind: "local_harness" }] };
  assert.equal(productRequiresLocalTools(corpus), true);
  for (const client of ["im", "dm", "web", "mcp"] as const) {
    assert.throws(() => assertProductUsable(true, client), { code: "product_requires_local_tools", status: 409 });
  }
  assert.doesNotThrow(() => assertProductUsable(true, "desktop"));
  assert.doesNotThrow(() => assertProductUsable(false, "im"));
});

test("a session cookie needs an allowed Origin and an API key is never accepted in a URL", () => {
  const allowed = ["https://app.hatch.test"];
  assert.deepEqual(checkUpgrade({ url: "/runtime" }, allowed), { ok: true });
  assert.deepEqual(checkUpgrade({ url: "/runtime", cookie: "hatch_session=abc", origin: "https://app.hatch.test" }, allowed), { ok: true });
  assert.equal(checkUpgrade({ url: "/runtime", cookie: "hatch_session=abc", origin: "https://evil.test" }, allowed).ok, false);
  assert.equal(checkUpgrade({ url: "/runtime", cookie: "hatch_session=abc" }, allowed).ok, false);
  const inUrl = checkUpgrade({ url: "/runtime?api_key=hk_secret" }, allowed);
  assert.equal(inUrl.ok === false && inUrl.code, "credential_in_url");
  assert.equal(sessionTokenFromCookie("a=1; hatch_session=tok%3D; b=2"), "tok=");
});

test("partial output is saved at most once per interval and flushed at the end", async () => {
  let now = 0;
  const saved: string[] = [];
  const saver = throttled<string>(1000, async (text) => { saved.push(text); }, () => now);
  saver.push("a"); now = 100; saver.push("ab"); now = 200; saver.push("abc");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saved, ["a"]);
  await saver.flush();
  assert.deepEqual(saved, ["a", "abc"]);
  const published: unknown[] = [];
  const wrapped = withPartialOutput((message) => published.push(message), async (text) => { saved.push(text); }, 0);
  wrapped.publish({ type: "assistant.delta", delta: { kind: "text", content: "hi" } });
  wrapped.publish({ type: "assistant.delta", delta: { kind: "status", content: "thinking" } });
  await wrapped.flush();
  assert.equal(published.length, 2);
  assert.equal(saved.at(-1), "hi");
});

test("a Run that only read restarts; one that used a local or side-effecting tool is interrupted", async () => {
  const run = { id: "r", conversationId: "c", status: "running" } as ConversationRunRecord;
  const policy = (calls: Array<{ name: string; locality?: "server" | "client" }>) => new ReadOnlyRestartPolicy({ callsOf: async () => calls });
  assert.equal(await policy([{ name: "hatch.web_search", locality: "server" }, { name: "Skill", locality: "server" }]).decide(run), "restart");
  assert.deepEqual(Object.keys(await policy([{ name: "file_write", locality: "client" }]).decide(run)), ["interrupt"]);
  assert.deepEqual(Object.keys(await policy([{ name: "api.request", locality: "server" }]).decide(run)), ["interrupt"]);
  assert.deepEqual(Object.keys(await policy([]).decide({ ...run, status: "waiting_for_tool" })), ["interrupt"]);
});

const productId = "11111111-1111-4111-8111-111111111111";
const creatorId = "22222222-2222-4222-8222-222222222222";
const corpus = (tools: Array<{ kind: string }>) => ({
  digest: "sha256:abc", root: "/tmp/none",
  corpus: { creator: { id: creatorId, name: "C" }, product: { id: productId, name: "P", boundaries: [], presentation: {} }, tools, agent_id: productId }
}) as unknown as ResolvedAgentCorpus;
const connection = (patch: Partial<Connection> = {}): Connection => ({
  id: "conn-1", ownerAccountId: "owner", channel: "instagram", client: "dm", target: { kind: "product", productId }, audience: "public", state: "active", ...patch
});

test("a contact is bound to its Connection's Product with no order, and isolated by connection and contact", async () => {
  const repository = new InMemoryConversationRepository();
  const connections = { get: async (id: string) => id === "conn-1" ? connection() : id === "conn-2" ? connection({ id: "conn-2" }) : undefined };
  const binder = new ContactBinder(connections, { resolveByProduct: async () => corpus([{ kind: "http_function" }]) }, repository);
  const alice = { kind: "contact" as const, connectionId: "conn-1", contactId: "alice" };
  const first = await binder.bind(alice, { kind: "thread", connectionId: "conn-1", threadId: "t1" });
  const again = await binder.bind(alice, { kind: "thread", connectionId: "conn-1", threadId: "t1" });
  assert.equal(first.conversation.id, again.conversation.id);
  assert.equal(first.conversation.ownerAccountId, principalKey(alice));
  const bob = await binder.bind({ ...alice, contactId: "bob" }, { kind: "thread", connectionId: "conn-1", threadId: "t1" });
  const sameContactOtherConnection = await binder.bind({ ...alice, connectionId: "conn-2" }, { kind: "thread", connectionId: "conn-2", threadId: "t1" });
  assert.equal(new Set([first.conversation.id, bob.conversation.id, sameContactOtherConnection.conversation.id]).size, 3);
  // Another contact cannot open this conversation by id, nor can a thread of another connection be addressed.
  await assert.rejects(binder.bind({ ...alice, contactId: "bob" }, { kind: "conversation", id: first.conversation.id }), { code: "conversation_not_found" });
  await assert.rejects(binder.bind(alice, { kind: "thread", connectionId: "conn-2", threadId: "t1" }), { code: "conversation_not_found" });
  assert.equal((await binder.bind(alice, { kind: "conversation", id: first.conversation.id })).conversation.id, first.conversation.id);
});

test("a contact is refused on a revoked or self Connection, an org member is bound like a customer, and past its message limit", async () => {
  const repository = new InMemoryConversationRepository();
  const products = { resolveByProduct: async () => corpus([{ kind: "http_function" }]) };
  const alice = { kind: "contact" as const, connectionId: "conn-1", contactId: "alice" };
  const ref = { kind: "thread" as const, connectionId: "conn-1", threadId: "t" };
  await assert.rejects(new ContactBinder({ get: async () => connection({ state: "revoked" }) }, products, repository).bind(alice, ref), { code: "connection_unavailable" });
  await assert.rejects(new ContactBinder({ get: async () => connection({ audience: "self" }) }, products, repository).bind(alice, ref), { code: "connection_not_shared" });
  const member = await new ContactBinder({ get: async () => connection({ audience: "org" }) }, products, repository).bind(alice, ref);
  assert.equal(member.conversation.productId, productId);
  const bound = await new ContactBinder({ get: async () => connection() }, products, repository).bind(alice, ref);
  const limits = new SentMessageLimits({ countSentMessages: async () => 3 }, 3);
  await assert.rejects(limits.check(alice, bound.conversation), (error: unknown) => error instanceof ChatError && error.status === 429);
  await new SentMessageLimits({ countSentMessages: async () => 3 }, 3).check({ kind: "account", accountId: "a" }, bound.conversation);
});
