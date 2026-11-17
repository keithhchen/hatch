import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PortalStateStore } from "../portalState.mjs";

test("Portal state permanently removes pre-cutover Offer fields when opened", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-portal-offer-cutover-"));
  const filePath = path.join(directory, "portal.json");
  await writeFile(filePath, JSON.stringify({
    contract_version: "1",
    checkout_sessions: {
      checkout_legacy: {
        checkout_session_id: "checkout_legacy",
        offer_snapshot: { offer_id: "offer_legacy", revision: 3 },
        quote_change: { previous: 0, current: 4900 }
      }
    },
    creator_products: {
      "creator:product": {
        status: "offer_required",
        offer_draft: { revision: 3 },
        offer_active: { revision: 2 },
        publish_operation: { operation_id: "publish_legacy", offer_revision: 3, offer_activated_at: "2026-01-01T00:00:00.000Z" }
      }
    }
  }), "utf8");

  const store = await PortalStateStore.open({ filePath });
  assert.equal(store.getCheckoutSession("checkout_legacy").offer_snapshot, undefined);
  const persisted = await readFile(filePath, "utf8");
  assert.doesNotMatch(persisted, /offer_snapshot|quote_change|offer_draft|offer_active|offer_revision|offer_activated_at|offer_required/);
  assert.match(persisted, /ready_to_preview/);
});

test("Portal state persists checkout sessions and replays request keys", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-portal-state-"));
  const filePath = path.join(directory, "portal.json");
  const store = await PortalStateStore.open({ filePath });
  const first = await store.createCheckoutSession({
    buyer_id: "buyer-1",
    request_key: "request-1",
    product: { product_id: "product-1" },
    totals: { total_minor: 0, currency: "USD" }
  });
  const replay = await store.createCheckoutSession({
    buyer_id: "buyer-1",
    request_key: "request-1",
    product: { product_id: "ignored" }
  });
  assert.equal(replay.checkout_session_id, first.checkout_session_id);

  const reopened = await PortalStateStore.open({ filePath });
  assert.equal(reopened.getCheckoutSession(first.checkout_session_id).product.product_id, "product-1");

  const concurrent = await Promise.all(Array.from({ length: 8 }, () => store.createCheckoutSession({
    buyer_id: "buyer-concurrent",
    request_key: "request-concurrent",
    product: { product_id: "product-concurrent" },
    totals: { total_minor: 0, currency: "USD" }
  })));
  assert.equal(new Set(concurrent.map((session) => session.checkout_session_id)).size, 1);
});

test("Expired checkout sessions are rejected before any Commerce mutation can begin", async () => {
  let now = new Date("2026-08-01T00:00:00.000Z");
  const store = await PortalStateStore.open({ clock: () => now });
  const session = await store.createCheckoutSession({
    buyer_id: "buyer-expired",
    request_key: "expired-request",
    product: { product_id: "product-expired" },
    totals: { total_minor: 0, currency: "USD" }
  });
  now = new Date("2026-08-01T00:31:00.000Z");
  assert.equal(store.getCheckoutSession(session.checkout_session_id).status, "expired");
  await assert.rejects(
    store.completeCheckout(session.checkout_session_id, { order_id: "must-not-exist" }),
    (error) => error.code === "checkout_expired"
  );
});
