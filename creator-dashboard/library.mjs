import { stateError } from "./portalState.mjs";

// "My library" is the account's active free entitlements in the Commerce ledger.
// Saving grants one (the free unmetered order path); removing revokes it. Chats are never touched.
export function createLibrary({ commerce, findProduct, grantInput }) {
  const activeFor = (accountId, productId) => commerce.listBuyerEntitlements(accountId)
    .find((entry) => entry.product_id === productId && entry.status === "active");
  // Concurrent commands for one (account, product) share one in-flight run, so a double
  // save/remove is one ledger write and only the first caller reports a change.
  const inFlight = new Map();
  const serialized = (accountId, productId, run) => {
    const key = `${accountId}:${productId}`;
    const pending = inFlight.get(key);
    if (pending) return pending.then(run, run);
    const started = run().finally(() => { if (inFlight.get(key) === started) inFlight.delete(key); });
    inFlight.set(key, started);
    return started;
  };

  const save = async ({ accountId, productId }) => {
    if (activeFor(accountId, productId)) return { saved: true, created: false };
    const product = await findProduct(productId);
    if (!product) throw stateError("agent_unavailable", "The published Agent could not be found.", 404);
    if (product.creator_id === accountId) return { saved: false, reason: "own_product" };
    if (product.availability !== "published") throw stateError("product_unavailable", "This Product is not available.", 409);
    // The key names one grant generation: every earlier grant of this pair has been
    // revoked (or none exists), so the count is the next generation. Retries of the same
    // generation replay the same ledger events; a re-save after a removal gets a new key.
    const generation = commerce.listBuyerEntitlements(accountId).filter((entry) => entry.product_id === productId).length;
    await commerce.confirmCheckout({
      ...grantInput(product, accountId),
      idempotency_key: `library:${accountId}:${productId}:${generation}`
    });
    return { saved: true, created: true };
  };

  const remove = async ({ accountId, productId }) => {
    const entitlement = activeFor(accountId, productId);
    if (!entitlement) return { removed: false };
    await commerce.refundOrder({
      order_id: entitlement.order_id,
      buyer_id: accountId,
      actor_id: accountId,
      reason: "removed_from_library",
      revoke_reason: "removed_from_library"
    }, { idempotencyKey: `library-remove:${entitlement.entitlement_id}` });
    return { removed: true };
  };

  return {
    saveToLibrary: (input) => serialized(input.accountId, input.productId, () => save(input)),
    removeFromLibrary: (input) => serialized(input.accountId, input.productId, () => remove(input))
  };
}
