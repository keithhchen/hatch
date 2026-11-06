import assert from "node:assert/strict";
import { test } from "node:test";
import { createConversationOwner } from "./conversation-owner.js";

const scope = conversationId => ({ accountId: "account", conversationId, accessKey: "product:agent" });

/** Native owner-registry double for this test only. */
function nativeRegistry({ owned = true } = {}) {
  const calls = [];
  let listener = null;
  return {
    calls,
    activate: payload => listener?.({ payload }),
    listen: async (event, handler) => { calls.push(["listen", event]); listener = handler; return () => { listener = null; }; },
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === "claim_conversation_session") return owned ? { owned: true, windowLabel: "main", lease: "lease-1" } : { owned: false, windowLabel: "conversation-x" };
      return undefined;
    }
  };
}

test("claim listens before acquiring and releases with the lease", async () => {
  const native = nativeRegistry();
  const owner = createConversationOwner({ invoke: native.invoke, listen: native.listen, onActivate() {}, onError() {} });
  const release = await owner.claim(scope("conv_a"));
  assert.deepEqual(native.calls.slice(0, 2), [["listen", "hatch://conversation-activate"], ["claim_conversation_session", scope("conv_a")]]);
  await release();
  assert.deepEqual(native.calls.at(-1), ["release_conversation_session", { accountId: "account", conversationId: "conv_a", lease: "lease-1" }]);
});

test("a conversation owned by another window resolves to null", async () => {
  const native = nativeRegistry({ owned: false });
  const owner = createConversationOwner({ invoke: native.invoke, listen: native.listen, onActivate() {}, onError() {} });
  assert.equal(await owner.claim(scope("conv_b")), null);
});

test("concurrent claims share one native request; activations reach the window", async () => {
  const native = nativeRegistry();
  const activated = [];
  const owner = createConversationOwner({ invoke: native.invoke, listen: native.listen, onActivate: payload => activated.push(payload), onError() {} });
  const [first, second] = await Promise.all([owner.claim(scope("conv_c")), owner.claim(scope("conv_c"))]);
  assert.equal(first, second);
  assert.equal(native.calls.filter(([command]) => command === "claim_conversation_session").length, 1);
  native.activate({ accountId: "account", accessKey: "product:agent", conversationId: "conv_c" });
  native.activate({ accountId: "account", conversationId: "conv_c" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(activated, [{ accountId: "account", accessKey: "product:agent", conversationId: "conv_c" }]);
  owner.dispose();
  assert.equal(await owner.claim(scope("conv_d")), null);
});
