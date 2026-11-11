import assert from "node:assert/strict";
import { test } from "node:test";
import type http from "node:http";
import { MAX_CONSUMER_BUFFERED_BYTES, SlowConsumerError, SseSink } from "./sinks.js";

test("a consumer with 1 MB unsent is disconnected, whatever the largest payload is", () => {
  let destroyed = false;
  const response = { writableEnded: false, destroyed: false, writableLength: 0, write: () => true, destroy: () => { destroyed = true; } };
  const sink = new SseSink(response as unknown as http.ServerResponse);
  sink.push({ type: "x", cursor: 1 });
  response.writableLength = MAX_CONSUMER_BUFFERED_BYTES + 1;
  assert.throws(() => sink.push({ type: "x", cursor: 2 }), SlowConsumerError);
  assert.equal(destroyed, true);
  assert.equal(MAX_CONSUMER_BUFFERED_BYTES, 1024 * 1024);
});

test("the bound is a constructor value; 1 MB is only the default", () => {
  const response = { writableEnded: false, destroyed: false, writableLength: 4097, write: () => true, destroy: () => undefined };
  assert.throws(() => new SseSink(response as unknown as http.ServerResponse, 4096).push({ type: "x" }), SlowConsumerError);
  assert.doesNotThrow(() => new SseSink(response as unknown as http.ServerResponse).push({ type: "x" }));
});
