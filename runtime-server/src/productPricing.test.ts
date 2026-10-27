import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_PRODUCT_PRICING, normalizeProductPricing } from "./creatorLearning/pricing.js";
import { InMemoryCreatorFactoryRepository } from "./creatorLearning/repository.js";

test("empty pricing keeps a Product fully free", () => {
  assert.deepEqual(normalizeProductPricing(undefined), EMPTY_PRODUCT_PRICING);
  assert.deepEqual(normalizeProductPricing({ free_messages: "", human_hourly_minor: null }), EMPTY_PRODUCT_PRICING);
});

test("a free-message limit requires at least one payment option", () => {
  assert.throws(() => normalizeProductPricing({ free_messages: 3 }), { code: "payment_option_required" });
  assert.deepEqual(normalizeProductPricing({ free_messages: 3, agent_monthly_minor: 2900 }), {
    free_messages: 3, human_hourly_minor: null, agent_monthly_minor: 2900, currency: "USD"
  });
  assert.deepEqual(normalizeProductPricing({ human_hourly_minor: 15000 }).human_hourly_minor, 15000);
});

test("pricing rejects non-integer, non-positive and non-USD values", () => {
  assert.throws(() => normalizeProductPricing({ free_messages: 0, agent_monthly_minor: 100 }), { code: "invalid_pricing" });
  assert.throws(() => normalizeProductPricing({ agent_monthly_minor: 9.5 }), { code: "invalid_pricing" });
  assert.throws(() => normalizeProductPricing({ agent_monthly_minor: 100, currency: "CNY" }), { code: "invalid_pricing" });
  assert.throws(() => normalizeProductPricing([]), { code: "invalid_pricing" });
});

test("repository saves pricing with the Product CAS contract", async () => {
  const repository = new InMemoryCreatorFactoryRepository();
  const product = await repository.createProduct({
    id: "5f0c5d0e-8d8b-4a8e-9b6a-3f1d2c4b5a69",
    creatorId: "creator",
    name: "Advisor",
    promise: "Helps families plan applications",
    briefSpec: { contract_version: "1", fields: [{ id: "goal", label: "Goal", required: true }] }
  });
  assert.deepEqual(product.pricing, EMPTY_PRODUCT_PRICING);
  const saved = await repository.savePricing("creator", product.id, {
    pricing: { free_messages: 3, human_hourly_minor: 20000, agent_monthly_minor: null, currency: "USD" },
    expectedUpdatedAt: product.updatedAt
  });
  assert.equal(saved.pricing.free_messages, 3);
  await assert.rejects(repository.savePricing("creator", product.id, {
    pricing: EMPTY_PRODUCT_PRICING,
    expectedUpdatedAt: "2000-01-01T00:00:00.000Z"
  }), { code: "version_conflict" });
});
