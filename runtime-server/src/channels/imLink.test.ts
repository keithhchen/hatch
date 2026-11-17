import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatError } from "../chat/principal.js";
import type { ChatGateway } from "../chat/gateway.js";
import type { ChannelConnection, Identity } from "./connections.js";
import { ImLinks } from "./imLink.js";
import type { Inbound } from "./ports.js";
import { ProductTarget } from "./productTarget.js";

const connection = (channel: "telegram" | "line"): ChannelConnection => ({ id: "c0000000-0000-4000-8000-000000000001", ownerAccountId: "a0000000-0000-4000-8000-000000000001", channel, scope: "", client: "im", target: { kind: "product", productId: "p1" }, audience: "public", taskSpecific: false, state: "active" });
const identity: Identity = { id: "d0000000-0000-4000-8000-000000000001", connectionId: connection("telegram").id, senderId: "u1", threadId: "u1" };

/** The contact lookup and account link, in memory. */
function links(now = () => new Date()) {
  const linked = new Map<string, string>();
  const connections = {
    contact: async (id: string) => id === identity.id ? { connection: connection("telegram"), identity } : undefined,
    linkAccount: async (_channel: string, sender: string, account: string) => (linked.get(sender) ?? linked.set(sender, account).get(sender)) === account,
  };
  return { linked, links: new ImLinks({ secret: "s3cret", origin: "https://hatch.test", connections, now }) };
}
const tokenOf = (url: string) => new URL(url).searchParams.get("t")!;

test("A link names the contact, is signed, and expires after 30 minutes", async () => {
  const clock = { at: new Date("2026-01-01T00:00:00Z") };
  const { links: signer } = links(() => clock.at);
  const url = signer.url(connection("telegram").id, identity.id);
  assert.match(url, /^https:\/\/hatch\.test\/link\/im\?t=[\w-]+\.[\w-]+$/);
  assert.equal((await signer.claim(tokenOf(url), "acct")).productId, "p1");
  clock.at = new Date(clock.at.getTime() + 29 * 60_000);
  await signer.claim(tokenOf(url), "acct");
  clock.at = new Date(clock.at.getTime() + 2 * 60_000);
  await assert.rejects(signer.claim(tokenOf(url), "acct"), { code: "im_link_expired", status: 410 });
});

test("A tampered or foreign token is invalid", async () => {
  const { links: signer } = links();
  const token = tokenOf(signer.url(connection("telegram").id, identity.id));
  const [payload, signature] = token.split(".") as [string, string];
  const forged = Buffer.from(JSON.stringify({ connectionId: connection("telegram").id, contactId: identity.id, exp: Date.now() + 1e12 })).toString("base64url");
  for (const bad of [`${forged}.${signature}`, `${payload}.${signature.slice(0, -2)}xx`, payload, "", "a.b"]) await assert.rejects(signer.claim(bad, "acct"), { code: "im_link_invalid", status: 400 });
  const other = new ImLinks({ secret: "other", origin: "https://hatch.test", connections: { contact: async () => undefined, linkAccount: async () => true } });
  await assert.rejects(other.claim(token, "acct"), { code: "im_link_invalid" });
});

test("Claiming is idempotent for one account and refused for another", async () => {
  const { links: signer, linked } = links();
  const token = tokenOf(signer.url(connection("telegram").id, identity.id));
  const first = await signer.claim(token, "a");
  assert.deepEqual(await signer.claim(token, "a"), first);
  await assert.rejects(signer.claim(token, "b"), { code: "im_already_linked", status: 409 });
  assert.equal(linked.get("u1"), "a");
});

test("A link for another Connection or an unknown contact is invalid", async () => {
  const { links: signer } = links();
  await assert.rejects(signer.claim(tokenOf(signer.url("c0000000-0000-4000-8000-0000000000ff", identity.id)), "a"), { code: "im_link_invalid" });
  await assert.rejects(signer.claim(tokenOf(signer.url(connection("telegram").id, "d0000000-0000-4000-8000-0000000000ff")), "a"), { code: "im_link_invalid" });
});

const inbound = (channel: "telegram" | "line"): Inbound => ({ connection: connection(channel), principal: { kind: "contact", connectionId: connection(channel).id, contactId: identity.id }, address: { connectionId: connection(channel).id, senderId: "u1", threadId: "u1" } } as Inbound);
const refusing = (error: Error): ChatGateway => ({ send: async () => { throw error; } } as unknown as ChatGateway);

test("login_required becomes a trilingual sign-in reply with a link, not retryable", async () => {
  const { links: signer } = links();
  const target = new ProductTarget({ gateway: refusing(new ChatError("login_required", "Sign in.", 403)), limiter: { take: async () => 0 }, imLinks: signer });
  const error = await target.send(inbound("telegram"), { key: "k", parts: [] }).catch(cause => cause) as ChatError;
  assert.ok(error instanceof ChatError);
  assert.deepEqual([error.code, error.status, error.retryable], ["login_required", 403, false]);
  assert.match(error.message, /免费消息[\s\S]*free messages[\s\S]*無料メッセージ/);
  assert.equal((await signer.claim(tokenOf(error.message.match(/https:\S+/)![0]), "a")).channel, "telegram");
});

test("A platform without people, or without a signer, gets the sign-in text with no link; other errors pass through", async () => {
  const { links: signer } = links();
  for (const [channel, imLinks] of [["line", signer], ["telegram", undefined]] as const) {
    const target = new ProductTarget({ gateway: refusing(new ChatError("login_required", "x", 403)), limiter: { take: async () => 0 }, ...(imLinks ? { imLinks } : {}) });
    const error = await target.send(inbound(channel), { key: "k", parts: [] }).catch(cause => cause) as ChatError;
    assert.equal(error.code, "login_required");
    assert.doesNotMatch(error.message, /https?:/);
    assert.match(error.message, /Hatch/);
  }
  const other = new ProductTarget({ gateway: refusing(new ChatError("contact_limit_reached", "limit", 429)), limiter: { take: async () => 0 }, imLinks: signer });
  await assert.rejects(other.send(inbound("telegram"), { key: "k", parts: [] }), { code: "contact_limit_reached" });
});
