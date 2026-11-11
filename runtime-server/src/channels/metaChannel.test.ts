import assert from "node:assert/strict";
import test from "node:test";
import { InstagramChannel } from "./instagramChannel.js";
import { classifyGraphError, type MetaChannel } from "./metaChannel.js";
import { MessengerChannel } from "./messengerChannel.js";
import { WhatsAppChannel } from "./whatsappChannel.js";
import { graphError, recorder, sign } from "./recorder.testkit.js";
import { conformance, TIMEOUT } from "./adapterConformance.js";
import { ChannelSendError } from "./types.js";

const SECRET = "app-secret";
const VERIFY = "verify-me";
const signed = (body: string | Buffer, secret = SECRET) => sign(body, secret);

const tokens = async (tenant: string) => tenant === "T1" ? "token-1" : undefined;
type Platform = { name: string; make: (fetchImpl?: typeof fetch, config?: object) => MetaChannel; object: string; thread: string; message: (id: string, timestamp: number) => Buffer };
const messaging = (object: string) => (id: string, timestamp: number) => Buffer.from(JSON.stringify({ object, entry: [{ id: "T1", messaging: [{ sender: { id: "C1" }, recipient: { id: "T1" }, timestamp, message: { mid: id, text: id } }] }] }));
const whatsapp = (id: string, timestamp: number) => Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "T1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" }, messages: [{ from: "C1", id, timestamp: String(timestamp), type: "text", text: { body: id } }] } }] }] }));
const platforms: Platform[] = [
  { name: "whatsapp", make: (fetchImpl, config) => new WhatsAppChannel({ appSecret: SECRET, verifyToken: VERIFY, tokens, ...config }, fetchImpl), object: "whatsapp_business_account", thread: "T1:PN1:C1", message: whatsapp },
  { name: "instagram", make: (fetchImpl, config) => new InstagramChannel({ appSecret: SECRET, verifyToken: VERIFY, tokens, ...config }, fetchImpl), object: "instagram", thread: "T1:C1", message: messaging("instagram") },
  { name: "messenger", make: (fetchImpl, config) => new MessengerChannel({ appSecret: SECRET, verifyToken: VERIFY, tokens, ...config }, fetchImpl), object: "page", thread: "T1:C1", message: messaging("page") },
];

test("classifyGraphError: throttled is refused outright, lost access is never retried, platform trouble may have gone through", () => {
  for (const code of [4, 17, 32, 613, 80007, 130429, 131056]) assert.deepEqual(classifyGraphError(400, { code }), { failure: "definite", access: false }, `code ${code}`);
  assert.deepEqual(classifyGraphError(429), { failure: "definite", access: false });
  for (const code of [190, 102, 368, 131005, 200, 299]) assert.deepEqual(classifyGraphError(400, { code }), { failure: "permanent", access: true }, `code ${code}`);
  assert.deepEqual(classifyGraphError(401), { failure: "permanent", access: true });
  for (const code of [1, 2, 131000, 131057]) assert.deepEqual(classifyGraphError(400, { code }), { failure: "ambiguous", access: false }, `code ${code}`);
  assert.deepEqual(classifyGraphError(500), { failure: "ambiguous", access: false });
  assert.deepEqual(classifyGraphError(400, { code: 100, is_transient: true }), { failure: "ambiguous", access: false });
  // Outside the window is a refusal, not lost access; so are bad parameters and a number that cannot be messaged.
  assert.deepEqual(classifyGraphError(400, { code: 10, error_subcode: 2018278 }), { failure: "permanent", access: false });
  for (const code of [100, 131026, 131047, 551]) assert.deepEqual(classifyGraphError(400, { code }), { failure: "permanent", access: false }, `code ${code}`);
});

for (const { name, make, object, thread, message } of platforms) {
  const to = { threadId: thread, senderId: "C1" };
  conformance(name, {
    adapter: make(),
    send: async outcome => { await make(recorder(() => { if (outcome instanceof Error) throw outcome; return outcome.clone(); }).fake).send(to, { text: "hi" }, "k"); },
    cases: [
      { name: "a timeout", outcome: TIMEOUT, failure: "ambiguous" },
      { name: "HTTP 500", outcome: new Response("{}", { status: 500 }), failure: "ambiguous" },
      { name: "HTTP 429", outcome: new Response("{}", { status: 429 }), failure: "definite" },
      { name: "a throttled app (code 4)", outcome: graphError(400, { code: 4 }), failure: "definite" },
      { name: "an expired token (190)", outcome: graphError(400, { code: 190 }), failure: "permanent", access: true },
      { name: "a refused parameter (100)", outcome: graphError(400, { code: 100 }), failure: "permanent" },
      { name: "a send outside the window (10/2018278)", outcome: graphError(400, { code: 10, error_subcode: 2018278 }), failure: "permanent" },
    ],
    delivered: {
      duplicate: async () => [...make().parse(message("m1", 1)).events, ...make().parse(message("m1", 1)).events],
      ordered: async () => [[...make().parse(message("a", 1)).events, ...make().parse(message("b", 2)).events], [...make().parse(message("b", 2)).events, ...make().parse(message("a", 1)).events]],
    },
    forged: () => make().verify(message("m1", 1), { "x-hub-signature-256": signed(message("m1", 1), "not-the-secret") }),
  });

  test(`${name}: available needs the app secret, the verify token and tenant tokens`, () => {
    assert.equal(make().available(), true);
    for (const missing of ["appSecret", "verifyToken", "tokens"]) assert.equal(make(undefined, { [missing]: undefined }).available(), false);
    assert.equal(make().capabilities().replyWindowMs, 24 * 60 * 60_000);
    assert.equal(make().capabilities().canInitiate, false);
  });

  test(`${name}: verify accepts Meta's signature over the raw bytes, or over the escaped payload, and nothing else`, () => {
    const channel = make();
    const raw = Buffer.from(JSON.stringify({ object, text: "café 你好" }));
    assert.equal(channel.verify(raw, { "x-hub-signature-256": signed(raw) }), true);
    const escaped = Buffer.from(raw.toString().replace(/[\u0080-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`));
    assert.equal(channel.verify(raw, { "x-hub-signature-256": signed(escaped) }), true);
    assert.equal(channel.verify(Buffer.from(`${raw} `), { "x-hub-signature-256": signed(raw) }), false);
    assert.equal(channel.verify(raw, { "x-hub-signature-256": signed(raw, "other") }), false);
    assert.equal(channel.verify(raw, { "x-hub-signature-256": signed(raw).replace("sha256=", "sha1=") }), false);
    assert.equal(channel.verify(raw, { "x-hub-signature-256": "sha256=short" }), false);
    assert.equal(channel.verify(raw, {}), false);
    assert.equal(make(undefined, { appSecret: undefined }).verify(raw, { "x-hub-signature-256": signed(raw) }), false);
  });

  test(`${name}: challenge echoes the challenge only for the right token`, () => {
    const query = (token: string, mode = "subscribe") => new URLSearchParams({ "hub.mode": mode, "hub.verify_token": token, "hub.challenge": "1158201444" });
    assert.equal(make().challenge(query(VERIFY)), "1158201444");
    assert.equal(make().challenge(query("wrong")), undefined);
    assert.equal(make().challenge(query(VERIFY, "unsubscribe")), undefined);
    assert.equal(make().challenge(new URLSearchParams()), undefined);
    assert.equal(make(undefined, { verifyToken: undefined }).challenge(query("")), undefined);
  });

  test(`${name}: parse ignores a payload for another product and an empty batch`, () => {
    assert.deepEqual(make().parse(Buffer.from(JSON.stringify({ object: "other", entry: [{ id: "x" }] }))).events, []);
    assert.deepEqual(make().parse(Buffer.from(JSON.stringify({ object }))).events, []);
    assert.deepEqual(make().parse(Buffer.from(JSON.stringify({ object, entry: [] }))).events, []);
  });

  test(`${name}: send without access to the tenant is a permanent, access-lost failure and calls nothing`, async () => {
    const { calls, fake } = recorder();
    await assert.rejects(make(fake).send({ threadId: "T2:C1", senderId: "C1" }, { text: "hi" }, "k"), (error: unknown) =>
      error instanceof ChannelSendError && error.failure === "permanent" && error.options.access === true);
    assert.equal(calls.length, 0);
  });

  test(`${name}: send classifies what Graph answers`, async () => {
    const cases: Array<[Response, string, boolean | undefined, number | undefined]> = [
      [graphError(400, { code: 190, message: "token expired" }), "permanent", true, undefined],
      [graphError(400, { code: 100, message: "bad" }), "permanent", false, undefined],
      [graphError(429, { code: 4 }, { "retry-after": "7" }), "definite", false, 7000],
      [graphError(400, { code: 130429 }), "definite", false, undefined],
      [graphError(503, {}), "ambiguous", false, undefined],
      [new Response("<html>bad gateway</html>", { status: 502 }), "ambiguous", false, undefined],
    ];
    for (const [response, failure, access, retryAfterMs] of cases) {
      const { fake } = recorder(() => response.clone());
      await assert.rejects(make(fake).send(to, { text: "hi" }, "k"), (error: unknown) =>
        error instanceof ChannelSendError && error.failure === failure && error.options.access === access && error.options.retryAfterMs === retryAfterMs, `${failure}`);
    }
  });

  test(`${name}: a timeout may have reached the platform`, async () => {
    const { fake } = recorder(() => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
    await assert.rejects(make(fake).send(to, { text: "hi" }, "k"), (error: unknown) => error instanceof ChannelSendError && error.failure === "ambiguous");
  });
}
