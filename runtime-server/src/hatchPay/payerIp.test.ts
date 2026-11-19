import assert from "node:assert/strict";
import test from "node:test";
import { payerIp } from "./payerIp.js";

test("the payer is X-Real-IP from the merchant's proxy, else the first valid X-Forwarded-For hop", () => {
  assert.equal(payerIp({ "x-real-ip": "2001:db8::7", "x-forwarded-for": "203.0.113.9" }), "2001:db8::7");
  assert.equal(payerIp({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }), "203.0.113.9");
  assert.equal(payerIp({ "x-real-ip": "bogus", "x-forwarded-for": "198.51.100.4" }), "198.51.100.4");
  assert.equal(payerIp({ "x-real-ip": "bogus" }), undefined);
});
