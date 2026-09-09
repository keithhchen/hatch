import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribeFactoryEvents } from './factoryEvents.js';

test('a terminal event-stream failure reconnects, refreshes state and stops cleanly', t => {
  const streams = [];
  class EventSourceFixture {
    constructor(url) { this.url = url; this.closed = false; streams.push(this); }
    close() { this.closed = true; }
  }
  const previous = globalThis.EventSource;
  globalThis.EventSource = EventSourceFixture;
  t.after(() => { if (previous === undefined) delete globalThis.EventSource; else globalThis.EventSource = previous; });
  let pending;
  t.mock.method(globalThis, 'setTimeout', callback => { pending = callback; return 1; });
  t.mock.method(globalThis, 'clearTimeout', () => { pending = undefined; });
  let refreshes = 0;
  let failures = 0;
  const received = [];
  const dispose = subscribeFactoryEvents({ onOpen: () => refreshes++, onError: () => failures++, onMessage: e => received.push(e.data) });
  assert.equal(streams[0].url, '/v1/creator/factory-agents/events');
  streams[0].onopen();
  streams[0].onerror();
  assert.equal(streams[0].closed, true);
  assert.equal(streams[0].onmessage, null);
  assert.equal(failures, 1);
  assert.equal(streams.length, 1, 'retry is delayed');
  pending();
  assert.equal(streams.length, 2);
  streams[1].onopen();
  streams[1].onmessage({ data: 'new event' });
  assert.equal(refreshes, 2, 'opening the replacement stream refreshes missed state');
  assert.deepEqual(received, ['new event']);
  streams[1].onerror();
  const queuedRetry = pending;
  dispose();
  assert.equal(pending, undefined);
  queuedRetry();
  assert.equal(streams.length, 2, 'switching chats prevents an already-queued retry');
  assert.equal(streams[1].closed, true);
});
