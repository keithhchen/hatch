import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CommerceLedger, CommerceService } from "../../packages/commerce/src/index.js";
import { createLibrary } from "../library.mjs";

const productId = "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42";
const product = { creator_id: "creator-1", product_id: productId, product_name: "Resume", corpus_digest: "sha256:d", availability: "published" };

async function setup(overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-library-"));
  const ledger = await CommerceLedger.open({ filePath: path.join(directory, "ledger.jsonl") });
  const commerce = new CommerceService(ledger);
  const live = { current: { ...product, ...overrides } };
  const library = createLibrary({
    commerce,
    findProduct: async () => live.current,
    grantInput: (found, accountId) => ({
      buyer_id: accountId, creator_id: found.creator_id, agent_id: found.product_id, product_id: found.product_id,
      product_name: found.product_name, corpus_digest: found.corpus_digest, release_id: found.corpus_digest,
      gross_minor: 0, currency: "USD", access_mode: "unmetered"
    })
  });
  const types = () => ledger.listEvents().map((event) => event.event_type);
  const active = (account = "u1") => commerce.listBuyerEntitlements(account).filter((entry) => entry.status === "active");
  return { library, ledger, commerce, live, types, active };
}
const ids = { accountId: "u1", productId };

test("save creates one grant and a second save is a no-op", async () => {
  const { library, types, active } = await setup();
  assert.deepEqual(await library.saveToLibrary(ids), { saved: true, created: true });
  assert.deepEqual(await library.saveToLibrary(ids), { saved: true, created: false });
  assert.deepEqual(types(), ["order.placed", "entitlement.granted"]);
  assert.equal(active()[0].access_mode, "unmetered");
});

test("simultaneous saves make exactly one grant", async () => {
  const { library, types } = await setup();
  const results = await Promise.all(Array.from({ length: 5 }, () => library.saveToLibrary(ids)));
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(results.every((result) => result.saved), true);
  assert.deepEqual(types(), ["order.placed", "entitlement.granted"]);
});

test("an own product is never granted", async () => {
  const { library, types } = await setup({ creator_id: "u1" });
  assert.deepEqual(await library.saveToLibrary(ids), { saved: false, reason: "own_product" });
  assert.deepEqual(types(), []);
});

test("a missing or non-live product is rejected and grants nothing", async () => {
  const { library, live, types } = await setup({ availability: "withdrawn" });
  await assert.rejects(library.saveToLibrary(ids), { status: 409, code: "product_unavailable" });
  live.current = null;
  await assert.rejects(library.saveToLibrary(ids), { status: 404, code: "agent_unavailable" });
  assert.deepEqual(types(), []);
});

test("remove revokes with its reason and touches nothing else; a second remove is a no-op", async () => {
  const { library, types, active, ledger } = await setup();
  await library.saveToLibrary(ids);
  await library.saveToLibrary({ accountId: "u2", productId });
  assert.deepEqual(await library.removeFromLibrary(ids), { removed: true });
  assert.deepEqual(await library.removeFromLibrary(ids), { removed: false });
  assert.deepEqual(types().slice(4), ["order.refunded", "entitlement.revoked"]);
  assert.equal(ledger.listEvents().find((event) => event.event_type === "entitlement.revoked").reason, "removed_from_library");
  assert.equal(active("u1").length, 0);
  assert.equal(active("u2").length, 1);
  assert.deepEqual(await library.removeFromLibrary({ accountId: "nobody", productId }), { removed: false });
});

test("simultaneous removes revoke once", async () => {
  const { library, types } = await setup();
  await library.saveToLibrary(ids);
  const results = await Promise.all([library.removeFromLibrary(ids), library.removeFromLibrary(ids)]);
  assert.deepEqual(results.map((result) => result.removed).sort(), [false, true]);
  assert.equal(types().filter((type) => type === "entitlement.revoked").length, 1);
});

test("save, remove, save, remove repeats with a fresh grant each time", async () => {
  const { library, types, active, commerce } = await setup();
  for (let round = 1; round <= 3; round += 1) {
    assert.deepEqual(await library.saveToLibrary(ids), { saved: true, created: true });
    assert.equal(active().length, 1);
    assert.deepEqual(await library.removeFromLibrary(ids), { removed: true });
    assert.equal(active().length, 0);
    assert.equal(commerce.listBuyerEntitlements("u1").length, round);
  }
  assert.equal(types().filter((type) => type === "entitlement.granted").length, 3);
});
