import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatError } from "../chat/principal.js";
import type { ContentPart, DeliveryFailure } from "../surfaces/contract.js";
import type { Handled } from "./ports.js";
import { ChannelSendError, type ChannelAdapter, type InboundEvent } from "./types.js";

/** What a platform answers to a send, in the platform's own shape; an Error is a transport failure such as a timeout. */
export type SendOutcome = Response | Error;
export type SendCase = { name: string; outcome: SendOutcome; failure: DeliveryFailure; access?: boolean };

/**
 * The contract every adapter keeps, run against its own wire format. Test files supply the platform's payloads and
 * answers; this supplies the assertions, so each adapter is held to the same rules.
 */
export function conformance(name: string, spec: {
  adapter: ChannelAdapter;
  /** One send against a platform that answers `outcome`. */
  send(outcome: SendOutcome): Promise<void>;
  cases: SendCase[];
  delivered: {
    /** The same body, delivered twice. */
    duplicate(): Promise<InboundEvent[]>;
    /** Two messages in the order they were sent, then in the reverse order. */
    ordered(): Promise<[InboundEvent[], InboundEvent[]]>;
  };
  /** A request that carries no valid signature: verify must say no. */
  forged(): boolean;
}): void {
  test(`${name}: capabilities are numbers an outbox can use`, () => {
    const { maxLength, replyWindowMs } = spec.adapter.capabilities();
    assert.ok(Number.isInteger(maxLength) && maxLength > 0);
    assert.ok(replyWindowMs === undefined || replyWindowMs > 0);
    assert.ok(spec.adapter.maxFileBytes > 0);
  });
  test(`${name}: a forged request is refused`, () => { assert.equal(spec.forged(), false); });
  test(`${name}: a redelivered event keeps its id, so the inbox refuses the repeat`, async () => {
    const events = await spec.delivered.duplicate();
    assert.ok(events.length >= 2);
    assert.equal(new Set(events.map(event => event.eventId)).size, 1);
  });
  test(`${name}: events arriving out of order keep their own ids and threads`, async () => {
    const [inOrder, reversed] = await spec.delivered.ordered();
    const key = (events: InboundEvent[]) => events.map(event => `${event.eventId}|${event.address.threadId}|${event.address.senderId}`).sort();
    assert.ok(inOrder.length >= 2);
    assert.deepEqual(key(reversed), key(inOrder));
  });
  for (const row of spec.cases) test(`${name}: ${row.name} is ${row.failure}`, async () => {
    await assert.rejects(spec.send(row.outcome), (error: unknown) => {
      assert.ok(error instanceof ChannelSendError, String(error));
      assert.equal(error.failure, row.failure);
      assert.equal(Boolean(error.options.access), Boolean(row.access));
      return true;
    });
  });
}

/** A fetch that answers each call from `answer` and records the requests. */
export function fakeFetch(answer: (url: string, init: RequestInit | undefined, index: number) => SendOutcome | Promise<SendOutcome>) {
  const calls: Array<{ url: string; init?: RequestInit; body: any }> = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const text = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, init, body: text?.startsWith("{") ? JSON.parse(text) : text });
    const outcome = await answer(url, init, calls.length - 1);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

export const TIMEOUT = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

/** What a ChatTarget rig lets the conformance cases see and steer: the Agent behind the target is a fake that keeps what it was given. */
export type TargetRig = {
  /** An authorized sender's event, as the router hands it to the target. */
  deliver(event: InboundEvent): Promise<Handled>;
  /** Each distinct message the Agent was given, by key. A repeated key is the same message, as in Chat. */
  messages(): Array<{ key: string; parts: ContentPart[] }>;
  /** What the sender was told outside any conversation. */
  notices(): string[];
  /** The next call that stores a message fails with this. */
  failNext(error: Error): void;
  /** `persist` for every call that told the Agent a message or a press (a repeated key is the same message, and still a call), `act:<action>` for every decision taken because of a press (a decision repeated under the same press is not taken again). */
  trace(): string[];
  /** The next acknowledgement of a pressed button fails with this, as when the platform is unreachable. */
  failAcknowledgeNext(error: Error): void;
  /** What the sender was shown for each button press that was acknowledged. */
  acknowledgements(): string[];
};

/** A caption and three photos that Telegram delivered together, merged the way the inbox hands them to a target. */
export const albumEvent = (eventId: string): InboundEvent => ({
  eventId, address: { threadId: "42", senderId: "42" }, messageRef: "9", text: "三张图",
  files: [1, 2, 3].map(n => ({ ref: `f${n}`, name: `photo${n}.jpg`, size: 10 })),
});

/**
 * The contract every ChatTarget keeps, whichever Agent is behind it: the same event is the same message, an album is one
 * message, a refusal that will pass is retried and one that will not is answered, and a pressed button is stored before
 * anything is done about it.
 */
export function targetConformance(name: string, make: () => TargetRig | Promise<TargetRig>, options: { button?: InboundEvent } = {}): void {
  const text = (eventId: string): InboundEvent => ({ eventId, address: { threadId: "42", senderId: "42" }, messageRef: "9", text: "你好" });
  test(`${name}: an event delivered twice is one message and one Run`, async () => {
    const rig = await make();
    const first = await rig.deliver(text("e1"));
    const second = await rig.deliver(text("e1"));
    assert.equal(rig.messages().length, 1);
    assert.equal(second.runId, first.runId);
    assert.deepEqual(rig.messages()[0]!.parts, [{ type: "text", text: "你好" }]);
  });
  test(`${name}: the key names the channel, the scope and the event`, async () => {
    const rig = await make();
    await rig.deliver(text("e1"));
    assert.match(rig.messages()[0]!.key, /^telegram:[^:]*:e1$/);
  });
  test(`${name}: a media album is one message: its caption, then every photo in order`, async () => {
    const rig = await make();
    await rig.deliver(albumEvent("e2"));
    assert.equal(rig.messages().length, 1);
    assert.deepEqual(rig.messages()[0]!.parts.map(part => part.type), ["text", "image", "image", "image"]);
  });
  test(`${name}: a refusal that will pass returns the event to the queue, and the retry is the same message`, async () => {
    const rig = await make();
    rig.failNext(new ChatError("conversation_busy", "The previous run is still stopping.", 409));
    await assert.rejects(rig.deliver(text("e3")), (error: unknown) => error instanceof ChatError && error.retryable);
    assert.deepEqual(rig.notices(), []);
    assert.equal(rig.messages().length, 0);
    await rig.deliver(text("e3"));
    assert.equal(rig.messages().length, 1);
  });
  test(`${name}: a refusal that never changes is told to the sender and not retried`, async () => {
    const rig = await make();
    rig.failNext(new ChatError("invalid_request", "That cannot be sent.", 400));
    assert.deepEqual(await rig.deliver(text("e4")), { replied: true });
    assert.deepEqual(rig.notices(), ["That cannot be sent."]);
  });
  test(`${name}: a failure nobody classified is retried, never shown`, async () => {
    const rig = await make();
    rig.failNext(new Error("socket hang up"));
    await assert.rejects(rig.deliver(text("e5")), /socket hang up/);
    assert.deepEqual(rig.notices(), []);
  });
  const button = options.button;
  if (button) {
    const act = `act:${button.button!.action}`;
    test(`${name}: a button press is decided before the Agent is told, and a retry neither loses nor repeats either`, async () => {
      const rig = await make();
      rig.failNext(new ChatError("conversation_busy", "The previous run is still stopping.", 409));
      await assert.rejects(rig.deliver(button), (error: unknown) => error instanceof ChatError && error.retryable);
      assert.deepEqual(rig.trace(), [act], "the decision came first, and no Run was started for it");
      await rig.deliver(button);
      assert.deepEqual(rig.trace(), [act, "persist"], "the retry told the Agent without deciding again");
      await rig.deliver(button);
      assert.equal(rig.messages().length, 1, "the same press is the same message");
      assert.deepEqual(rig.trace().filter(step => step !== "persist"), [act], "decided once");
    });
    test(`${name}: approve succeeded, the acknowledgement failed, the update came again: one decision, the same reply`, async () => {
      const rig = await make();
      rig.failAcknowledgeNext(new Error("answerCallbackQuery timed out"));
      await assert.rejects(rig.deliver(button), /timed out/);
      assert.deepEqual(rig.trace(), [act, "persist"], "everything but the acknowledgement had been done");
      const redelivered = await rig.deliver(button);
      const again = await rig.deliver(button);
      assert.deepEqual(rig.trace().filter(step => step !== "persist"), [act], "nothing was decided twice");
      assert.equal(rig.messages().length, 1);
      assert.deepEqual(again, redelivered, "every redelivery answers the same");
      assert.equal(redelivered.replied, false);
      assert.ok(redelivered.runId);
      assert.deepEqual(rig.acknowledgements(), ["好", "好"], "the button was cleared on the retry");
    });
  }
}
