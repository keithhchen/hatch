import assert from "node:assert/strict";
import test from "node:test";
import { claimImLink } from "./imLink.js";

const failing = code => async () => { throw Object.assign(new Error(code), { code }); };

test("a claimed link opens the Agent it belongs to, and the token is sent once, as given", async () => {
  const calls = [];
  const state = await claimImLink(async (url, init) => { calls.push([url, init.method, init.body]); return { product_id: "p1" }; }, "?t=abc%20d");
  assert.deepEqual(state, { status: "linked", productId: "p1" });
  assert.deepEqual(calls, [["/v1/im-link/claim", "POST", JSON.stringify({ token: "abc d" })]]);
});

test("each refusal is its own state, and only an unavailable library or an unexpected failure can be retried", async () => {
  for (const [code, status] of [["im_link_invalid", "invalid"], ["im_link_expired", "expired"], ["im_already_linked", "alreadyLinked"], ["library_unavailable", "unavailable"], ["boom", "unavailable"]]) {
    assert.deepEqual(await claimImLink(failing(code), "?t=x"), { status }, code);
  }
});

test("a link without a token is invalid and asks nothing", async () => {
  let asked = false;
  assert.deepEqual(await claimImLink(async () => { asked = true; }, ""), { status: "invalid" });
  assert.equal(asked, false);
});
