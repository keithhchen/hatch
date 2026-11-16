import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCreatorFactoryRepository } from "./repository.js";
import { CreatorFactoryService } from "./service.js";

const CREATOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";

test("a Product is created once per idempotency key, edited, listed per Expert and soft-deleted", async () => {
  const service = new CreatorFactoryService(new InMemoryCreatorFactoryRepository());
  const created = await service.createProduct(CREATOR, { name: "Tax coach", promise: "Plain answers on tax", idempotencyKey: "k1" });
  const replay = await service.createProduct(CREATOR, { name: "Tax coach", promise: "Plain answers on tax", idempotencyKey: "k1" });
  assert.equal(replay.id, created.id);
  assert.equal(created.status, "active");

  const renamed = await service.updateProductPromise(CREATOR, created.id, { name: "Tax coach 2", promise: "Plain answers on tax and VAT" });
  assert.deepEqual([renamed.name, renamed.promise], ["Tax coach 2", "Plain answers on tax and VAT"]);

  assert.deepEqual((await service.listProducts(CREATOR)).map((product) => product.id), [created.id]);
  assert.deepEqual(await service.listProducts(OTHER), []);
  await assert.rejects(service.getProduct(OTHER, created.id));

  await service.deleteProduct(CREATOR, created.id);
  await assert.rejects(service.updateProductPromise(CREATOR, created.id, "Another promise"));
});
