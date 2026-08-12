import assert from "node:assert/strict";
import test from "node:test";
import { CommerceInvariantError, CommerceLedger, CommerceService } from "./index.js";

const PURCHASED_DIGEST = `sha256:${"1".repeat(64)}`;
const COMPATIBLE_DIGEST = `sha256:${"2".repeat(64)}`;
const NEXT_COMPATIBLE_DIGEST = `sha256:${"3".repeat(64)}`;

test("R28 compatible tracking advances only the effective digest and keeps an idempotent chain history", async () => {
  const ledger = new CommerceLedger();
  const commerce = new CommerceService(ledger);
  const checkout = await freeCheckout(commerce, "tracking", {
    corpus_digest: PURCHASED_DIGEST,
    release_id: "release_purchased",
    version_policy: "track_current_compatible"
  });
  assert.equal(checkout.entitlement.purchased_corpus_digest, PURCHASED_DIGEST);
  assert.equal(checkout.entitlement.effective_corpus_digest, PURCHASED_DIGEST);
  assert.deepEqual(checkout.entitlement.version_history, []);

  const first = await commerce.advanceEntitlementVersion({
    entitlement_id: checkout.entitlement.entitlement_id,
    from_digest: PURCHASED_DIGEST,
    to_digest: COMPATIBLE_DIGEST,
    from_release_id: "release_purchased",
    to_release_id: "release_compatible",
    compatibility_declaration_id: "compatibility_1",
    actor_id: "creator_tracking",
    idempotency_key: "entitlement:tracking:advance:1"
  });
  assert.equal(first.corpus_digest, PURCHASED_DIGEST);
  assert.equal(first.purchased_corpus_digest, PURCHASED_DIGEST);
  assert.equal(first.effective_corpus_digest, COMPATIBLE_DIGEST);
  assert.equal(first.version_history.length, 1);
  assert.deepEqual(first.version_history[0], {
    event_id: first.version_history[0].event_id,
    from_digest: PURCHASED_DIGEST,
    to_digest: COMPATIBLE_DIGEST,
    from_release_id: "release_purchased",
    to_release_id: "release_compatible",
    compatibility_declaration_id: "compatibility_1",
    reason: "compatible_release_published",
    actor_id: "creator_tracking",
    advanced_at: first.version_history[0].advanced_at
  });

  const replay = await commerce.advanceEntitlementVersion({
    entitlement_id: checkout.entitlement.entitlement_id,
    from_digest: PURCHASED_DIGEST,
    to_digest: COMPATIBLE_DIGEST,
    from_release_id: "release_purchased",
    to_release_id: "release_compatible",
    compatibility_declaration_id: "compatibility_1",
    actor_id: "creator_tracking",
    idempotency_key: "entitlement:tracking:advance:1"
  });
  assert.equal(replay.version_history.length, 1);
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "entitlement.version_advanced").length, 1);

  await assert.rejects(
    commerce.advanceEntitlementVersion({
      entitlement_id: checkout.entitlement.entitlement_id,
      from_digest: PURCHASED_DIGEST,
      to_digest: NEXT_COMPATIBLE_DIGEST,
      from_release_id: "release_purchased",
      to_release_id: "release_next",
      compatibility_declaration_id: "compatibility_2",
      actor_id: "creator_tracking",
      idempotency_key: "entitlement:tracking:advance:1"
    }),
    (error) => error instanceof CommerceInvariantError && error.code === "idempotency_conflict"
  );

  await assert.rejects(
    commerce.advanceEntitlementVersion({
      entitlement_id: checkout.entitlement.entitlement_id,
      from_digest: PURCHASED_DIGEST,
      to_digest: NEXT_COMPATIBLE_DIGEST,
      from_release_id: "release_purchased",
      to_release_id: "release_next",
      compatibility_declaration_id: "compatibility_broken_chain",
      idempotency_key: "entitlement:tracking:broken-chain"
    }),
    (error) => error instanceof CommerceInvariantError && error.code === "version_chain_broken"
  );
  await assert.rejects(
    ledger.append("entitlement.version_advanced", {
      entitlement_id: first.entitlement_id,
      order_id: first.order_id,
      buyer_id: first.buyer_id,
      creator_id: first.creator_id,
      agent_id: first.agent_id,
      product_id: first.product_id,
      from_digest: PURCHASED_DIGEST,
      to_digest: NEXT_COMPATIBLE_DIGEST,
      from_release_id: "release_purchased",
      to_release_id: "release_next",
      compatibility_declaration_id: "compatibility_direct_broken_chain",
      reason: "attempted_storage_bypass"
    }, { idempotencyKey: "entitlement:tracking:direct-broken-chain" }),
    (error) => error instanceof CommerceInvariantError && error.code === "version_chain_broken"
  );

  const second = await commerce.advanceEntitlementVersion({
    entitlement_id: checkout.entitlement.entitlement_id,
    from_digest: COMPATIBLE_DIGEST,
    to_digest: NEXT_COMPATIBLE_DIGEST,
    from_release_id: "release_compatible",
    to_release_id: "release_next",
    compatibility_declaration_id: "compatibility_2",
    idempotency_key: "entitlement:tracking:advance:2"
  });
  assert.equal(second.purchased_corpus_digest, PURCHASED_DIGEST);
  assert.equal(second.effective_corpus_digest, NEXT_COMPATIBLE_DIGEST);
  assert.equal(second.version_history.length, 2);

  const reserved = await commerce.authorizeAndReserve({
    entitlement_id: checkout.entitlement.entitlement_id,
    run_id: "run_tracking_version",
    idempotency_key: "reserve:tracking-version"
  });
  assert.equal(reserved.reservation.effective_corpus_digest, NEXT_COMPATIBLE_DIGEST);
});

test("R28 rejects pinned entitlements and no-op target digests", async () => {
  const ledger = new CommerceLedger();
  const commerce = new CommerceService(ledger);
  const pinned = await freeCheckout(commerce, "pinned", {
    corpus_digest: PURCHASED_DIGEST,
    release_id: "release_pinned",
    version_policy: "pinned"
  });
  await assert.rejects(
    commerce.advanceEntitlementVersion({
      entitlement_id: pinned.entitlement.entitlement_id,
      from_digest: PURCHASED_DIGEST,
      to_digest: COMPATIBLE_DIGEST,
      from_release_id: "release_pinned",
      to_release_id: "release_compatible",
      compatibility_declaration_id: "compatibility_pinned",
      idempotency_key: "entitlement:pinned:advance"
    }),
    (error) => error instanceof CommerceInvariantError && error.code === "version_policy_pinned"
  );

  const tracking = await freeCheckout(commerce, "no_op", {
    corpus_digest: PURCHASED_DIGEST,
    release_id: "release_no_op",
    version_policy: "track_current_compatible"
  });
  await assert.rejects(
    commerce.advanceEntitlementVersion({
      entitlement_id: tracking.entitlement.entitlement_id,
      from_digest: PURCHASED_DIGEST,
      to_digest: PURCHASED_DIGEST,
      from_release_id: "release_no_op",
      to_release_id: "release_no_op",
      compatibility_declaration_id: "compatibility_no_op",
      idempotency_key: "entitlement:no-op:advance"
    }),
    (error) => error instanceof CommerceInvariantError && error.code === "version_unchanged"
  );
  await assert.rejects(
    commerce.advanceEntitlementVersion({
      entitlement_id: tracking.entitlement.entitlement_id,
      from_digest: PURCHASED_DIGEST,
      to_digest: COMPATIBLE_DIGEST,
      from_release_id: "release_no_op",
      to_release_id: "release_compatible",
      idempotency_key: "entitlement:missing-compatibility-declaration"
    }),
    (error) => error instanceof CommerceInvariantError && error.code === "invalid_command"
  );
  assert.equal(ledger.listEvents().some((event) => event.event_type === "entitlement.version_advanced"), false);
});

function freeCheckout(commerce, suffix, overrides = {}) {
  return commerce.confirmCheckout({
    buyer_id: `buyer_${suffix}`,
    creator_id: `creator_${suffix}`,
    agent_id: `agent_${suffix}`,
    product_id: `product_${suffix}`,
    corpus_digest: overrides.corpus_digest ?? PURCHASED_DIGEST,
    release_id: overrides.release_id,
    version_policy: overrides.version_policy,
    gross_minor: 0,
    currency: "USD",
    idempotency_key: `checkout:${suffix}`
  });
}
