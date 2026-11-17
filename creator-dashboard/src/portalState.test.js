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
  const persisted = await readFile(filePath, "utf8");
  assert.doesNotMatch(persisted, /checkout_sessions|checkout_legacy|offer_snapshot|quote_change|offer_draft|offer_active|offer_revision|offer_activated_at|offer_required/);
  assert.match(persisted, /ready_to_preview/);
});
