import assert from "node:assert/strict";
import test from "node:test";
import { FreeChatMeter, freeChatAccess } from "../src/domain/free-chat.js";

const pricing = { free_messages: 3, human_hourly_minor: 20000, agent_monthly_minor: null, currency: "USD" };

test("no free-message limit keeps chat open", () => {
  assert.equal(freeChatAccess(null, 99).locked, false);
  assert.equal(freeChatAccess({ free_messages: null, agent_monthly_minor: 2900 }, 99).locked, false);
});

test("access locks once the limit is used and lists only the expert's options", () => {
  assert.equal(freeChatAccess(pricing, 2).locked, false);
  assert.equal(freeChatAccess(pricing, 2).remaining, 1);
  const locked = freeChatAccess(pricing, 3);
  assert.equal(locked.locked, true);
  assert.deepEqual(locked.options, [{ id: "human", amount_minor: 20000 }]);
});

test("the meter syncs Runtime's count, records accepted messages and notifies views", () => {
  const meter = new FreeChatMeter(pricing);
  let notified = 0;
  meter.subscribe(() => { notified += 1; });
  meter.sync(2);
  assert.equal(meter.getSnapshot().locked, false);
  meter.record();
  assert.equal(meter.getSnapshot().locked, true);
  meter.sync(undefined);
  assert.equal(meter.count, 3);
  assert.equal(notified, 2);
});
