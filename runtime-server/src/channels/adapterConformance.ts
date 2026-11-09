import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeliveryFailure } from "../surfaces/contract.js";
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
