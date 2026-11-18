import assert from "node:assert/strict";
import { test } from "node:test";
import { GuestAwareIdentityResolver, GuestTokens } from "../guestToken.js";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import { TASK_START_DIGEST } from "../protocol.js";
import { ChatError, accountOf, userPrincipal } from "./principal.js";
import { SentMessageLimits } from "./contactBinding.js";
import { GuestCarryOver, RetryingLibrary, type Library } from "./library.js";

const guestId = "g".repeat(22);
const tokens = new GuestTokens("secret-a");

test("a guest token names its guest, and nobody else can make one", async () => {
  const token = tokens.issue(guestId);
  assert.deepEqual(tokens.verify(token), { sub: `guest:${guestId}` });
  assert.equal(tokens.idOf(token), guestId);
  assert.equal(new GuestTokens("secret-b").verify(token), undefined, "another secret");
  assert.equal(tokens.verify(token.replace(guestId, "h".repeat(22))), undefined, "another id");
  assert.equal(tokens.verify(`${token}.x`), undefined);
  assert.equal(tokens.verify("not-a-guest-token"), undefined);
  assert.equal(tokens.verify(tokens.issue("short")), undefined, "an id that cannot be ours");
});

test("only guest tokens are identified without the Registry", async () => {
  const asked: Array<string | undefined> = [];
  const resolver = new GuestAwareIdentityResolver(tokens, { resolveIdentity: async (token) => { asked.push(token); return token === "account-token" ? { sub: "account-1" } : undefined; } });
  assert.deepEqual(await resolver.resolveIdentity(tokens.issue(guestId)), { sub: `guest:${guestId}` });
  assert.deepEqual(await resolver.resolveIdentity("account-token"), { sub: "account-1" });
  assert.equal(await resolver.resolveIdentity(`hatch_guest.${guestId}.forged`), undefined, "a forged guest token never reaches the Registry as an account");
  assert.deepEqual(asked, ["account-token"]);
});

test("a user id is a guest or an account, and only an account has a library", () => {
  assert.deepEqual(userPrincipal(`guest:${guestId}`), { kind: "guest", guestId });
  assert.deepEqual(userPrincipal("account-1"), { kind: "account", accountId: "account-1" });
  assert.equal(accountOf(userPrincipal(`guest:${guestId}`)), undefined);
  assert.equal(accountOf({ kind: "account", accountId: `guest:${guestId}` }), undefined, "a system Run in a guest's conversation saves nothing");
  assert.equal(accountOf({ kind: "account", accountId: "account-1" }), "account-1");
  assert.equal(accountOf({ kind: "contact", connectionId: "c", contactId: "p" }), undefined);
  assert.equal(accountOf({ kind: "contact", connectionId: "c", contactId: "p", accountId: "account-1" }), "account-1");
});

const conversation = { ownerAccountId: "o", creatorId: "c", agentId: "a" } as never;
const sentLimits = (count: number, max = 1000) => new SentMessageLimits({ countSentMessages: async () => count }, max);

test("a guest and an unlinked contact may send three messages to an Agent, then must sign in", async () => {
  const guest = { kind: "guest" as const, guestId };
  const contact = { kind: "contact" as const, connectionId: "c", contactId: "p" };
  for (const principal of [guest, contact]) {
    await sentLimits(2).check(principal, conversation);
    await assert.rejects(sentLimits(3).check(principal, conversation), (error: unknown) => error instanceof ChatError && error.code === "login_required" && error.status === 403 && !error.retryable);
  }
});

test("an account, and a contact whose person signed in, are not asked to sign in; a contact still has its cap", async () => {
  await sentLimits(50).check({ kind: "account", accountId: "a" }, conversation);
  const linked = { kind: "contact" as const, connectionId: "c", contactId: "p", accountId: "a" };
  await sentLimits(999).check(linked, conversation);
  await assert.rejects(sentLimits(1000).check(linked, conversation), (error: unknown) => error instanceof ChatError && error.code === "contact_limit_reached" && error.status === 429);
});

const binding = (ownerAccountId: string, productId = "p1") => ({ ownerAccountId, creatorId: "creator", agentId: productId, productId, corpusDigest: "d" });

test("the Run that starts a task from its Brief is not one of the three messages", async () => {
  const repository = new InMemoryConversationRepository();
  const owner = binding(`guest:${guestId}`);
  await repository.createConversation({ ...owner, id: "c1", publicId: "conv_1" });
  const run = (n: number, inputDigest: string) => ({ binding: owner, run: { id: `r${n}`, conversationId: "c1", clientMessageId: `m${n}`, inputDigest, corpusDigest: "d", executorId: "e" }, canonicalUser: { role: "user" as const, content: "x" } });
  await repository.acceptSubmission(run(1, TASK_START_DIGEST));
  assert.equal(await repository.countSentMessages(owner), 0);
});

test("a visitor's conversations become the account's, once, and the account finds them by the id it knew", async () => {
  const repository = new InMemoryConversationRepository();
  const from = `guest:${guestId}`;
  await repository.createConversation({ ...binding(from), id: "c1", publicId: "conv_1", clientRequestId: "k" });
  await repository.createConversation({ ...binding(from, "p2"), id: "c2", publicId: "conv_2" });
  await repository.createConversation({ ...binding("someone-else"), id: "c3", publicId: "conv_3" });
  assert.deepEqual((await repository.ownedProductIds(from)).sort(), ["p1", "p2"]);

  assert.equal(await repository.reown(from, "account-1"), 2);
  assert.equal(await repository.reown(from, "account-1"), 0, "repeating moves nothing more");
  assert.deepEqual(await repository.ownedProductIds(from), []);
  assert.equal((await repository.findOwnedConversation({ ownerAccountId: "account-1", creatorId: "creator" }, "conv_1"))?.id, "c1");
  assert.equal((await repository.getConversation("c3"))?.ownerAccountId, "someone-else");
  // The account's own conversation with the same request key does not collide with the one that moved.
  const again = await repository.createConversation({ ...binding("account-1"), id: "c4", publicId: "conv_4", clientRequestId: "k" });
  assert.equal(again.created, true);
});

test("carrying a visitor over saves their Agents first; a failed save moves nothing, and doing it again finishes", async () => {
  const repository = new InMemoryConversationRepository();
  const from = `guest:${guestId}`;
  await repository.createConversation({ ...binding(from), id: "c1", publicId: "conv_1" });
  await repository.createConversation({ ...binding(from, "p2"), id: "c2", publicId: "conv_2" });
  const saved: string[] = [];
  let failing = true;
  const library: Library = { save: async (account, productId) => { if (failing && productId === "p2") throw new Error("library down"); saved.push(`${account}:${productId}`); return true; } };
  const carry = new GuestCarryOver({ repository, library });

  await assert.rejects(carry.carry(from, "account-1"), /library down/);
  assert.deepEqual(await repository.ownedProductIds("account-1"), [], "nothing moved");
  assert.deepEqual((await repository.ownedProductIds(from)).sort(), ["p1", "p2"]);

  failing = false;
  assert.deepEqual(await carry.carry(from, "account-1"), { moved: 2 });
  assert.deepEqual(await carry.carry(from, "account-1"), { moved: 0 });
  assert.deepEqual([...new Set(saved)].sort(), ["account-1:p1", "account-1:p2"]);
});

test("a library save is retried with backoff, fails only when every attempt failed, and a failure is not remembered as saved", async () => {
  let down = 3;
  const calls: string[] = [];
  const pauses: number[] = [];
  const inner: Library = { save: async (account, productId) => { calls.push(`${account}:${productId}`); if (down-- > 0) throw new Error("library down"); return true; } };
  const library = new RetryingLibrary(inner, [10, 20], async (ms) => { pauses.push(ms); });

  await assert.rejects(library.save("a1", "p1"), /library down/);
  assert.equal(calls.length, 3, "the first try and two retries");
  assert.deepEqual(pauses, [10, 20]);

  // The next Run that starts asks again, because nothing was cached as saved; this time the library is back.
  assert.equal(await library.save("a1", "p1"), true);
  assert.equal(calls.length, 4);
  assert.equal(await library.save("a1", "p1"), true);
  assert.equal(calls.length, 5, "saving is asked every time; the library answers idempotently");
});
