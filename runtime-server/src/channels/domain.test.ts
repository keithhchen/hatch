import assert from "node:assert/strict";
import test from "node:test";
import { assertReachable, principalFor, type ChannelConnection } from "./connections.js";
import { replyWindowOpen } from "./dispatch.js";
import { render } from "./render.js";
import { failureForStatus, idempotencyId } from "./types.js";

const connection = (audience: ChannelConnection["audience"]): ChannelConnection => ({ id: "c1", ownerAccountId: "a1", channel: "telegram", scope: "", client: "im", target: { kind: "product", productId: "p" }, audience, state: "active" });
const identity = { id: "i1", connectionId: "c1", senderId: "s", threadId: "t" };

test("Only the owner acts as an account; org members and the public are contacts of that Connection", () => {
  assert.deepEqual(principalFor(connection("self"), identity), { kind: "account", accountId: "a1" });
  assert.deepEqual(principalFor(connection("org"), identity), { kind: "contact", connectionId: "c1", contactId: "i1" });
  assert.deepEqual(principalFor(connection("public"), identity), { kind: "contact", connectionId: "c1", contactId: "i1" });
});

test("Only a self Connection can reach the Assistant", () => {
  assert.doesNotThrow(() => assertReachable({ audience: "self", target: { kind: "assistant" } }));
  assert.throws(() => assertReachable({ audience: "public", target: { kind: "assistant" } }), /Only a self Connection/);
  assert.throws(() => assertReachable({ audience: "org", target: { kind: "assistant" } }), /Only a self Connection/);
  assert.doesNotThrow(() => assertReachable({ audience: "public", target: { kind: "product", productId: "p" } }));
});

test("render splits long text in order without losing a character or cutting a surrogate pair", () => {
  const text = `${"héllo wörld ".repeat(100)}\n\n${"😀".repeat(300)}`;
  const parts = render({ text }, { buttons: true, maxLength: 200 });
  assert.ok(parts.every(part => part.text.length <= 200));
  assert.ok(parts.length > 8);
  assert.equal(parts.map(part => part.text).join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
  assert.ok(parts.every(part => ![...part.text].includes("�")));
  assert.ok(parts.every(part => !/[\ud800-\udbff]$/.test(part.text) && !/^[\udc00-\udfff]/.test(part.text)));
});

test("render splits by bytes where the platform counts bytes, and a reply that fits is one message", () => {
  const fits = (text: string, maxBytes: number) => render({ text }, { buttons: false, maxLength: maxBytes, maxBytes });
  assert.equal(fits("a".repeat(20_480), 20_480).length, 1);
  const cjk = fits("汉".repeat(7_000), 20_480);
  assert.deepEqual(cjk.map(part => part.text.length), [6_826, 174]);
  assert.ok(cjk.every(part => Buffer.byteLength(part.text) <= 20_480));
  const emoji = fits("😀".repeat(600), 2_048);
  assert.ok(emoji.every(part => Buffer.byteLength(part.text) <= 2_048 && ![...part.text].includes("�")));
  assert.equal(emoji.map(part => part.text).join(""), "😀".repeat(600));
});

test("render puts the quote on the first message and buttons on the last", () => {
  const buttons = [{ label: "OK", taskId: "t", action: "approve" as const }];
  const parts = render({ text: `${"a".repeat(150)}\n\n${"b".repeat(150)}`, replyTo: "m1", buttons }, { buttons: true, maxLength: 200 });
  assert.equal(parts.length, 2);
  assert.equal(parts[0]!.replyTo, "m1");
  assert.equal(parts[1]!.replyTo, undefined);
  assert.equal(parts[0]!.buttons, undefined);
  assert.deepEqual(parts[1]!.buttons, buttons);
});

test("render turns buttons into a typed instruction where the platform has none", () => {
  const [part, ...rest] = render({ text: "Publish?", buttons: [{ label: "确认", taskId: "t", action: "approve" }, { label: "取消", taskId: "t", action: "decline" }] }, { buttons: false, maxLength: 200 });
  assert.equal(rest.length, 0);
  assert.equal(part!.buttons, undefined);
  assert.equal(part!.text, "Publish?\n\n回复「确认」或「取消」");
});

test("The reply window is open until the platform's limit after the last inbound message", () => {
  const at = new Date("2026-11-10T00:00:00Z");
  assert.equal(replyWindowOpen({}, undefined, at), true, "no window: always open");
  assert.equal(replyWindowOpen({ replyWindowMs: 1000 }, new Date(at.getTime() - 1000), at), true);
  assert.equal(replyWindowOpen({ replyWindowMs: 1000 }, new Date(at.getTime() - 1001), at), false);
  assert.equal(replyWindowOpen({ replyWindowMs: 1000 }, undefined, at), false, "nothing inbound: nothing to reply to");
});

test("HTTP statuses map to what may have happened", () => {
  assert.equal(failureForStatus(429), "definite");
  assert.equal(failureForStatus(403), "permanent");
  assert.equal(failureForStatus(400), "permanent");
  assert.equal(failureForStatus(408), "ambiguous");
  assert.equal(failureForStatus(502), "ambiguous");
});

test("An idempotency key becomes the same UUID-shaped value every time", () => {
  assert.equal(idempotencyId("d:0"), idempotencyId("d:0"));
  assert.notEqual(idempotencyId("d:0"), idempotencyId("d:1"));
  assert.match(idempotencyId("d:0"), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
