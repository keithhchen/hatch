import { randomUUID } from "node:crypto";
import type { DistillationGraphStore } from "./distillationGraph.js";
import { isCreatorProductRepository, validateProductText, type CreatorProductRecord } from "./products.js";
import { CreatorFactoryRepositoryError, type CreatorFactoryRepository } from "./repository.js";
import { draftBriefSpecForProduct, normalizeBriefSpec, type BriefSpec } from "../brief.js";
import { normalizeProductPricing } from "./pricing.js";
import { agentCreated } from "../analytics/events.js";
import { safely } from "../analytics/safe.js";
import type { ProductAnalytics } from "../analytics/port.js";

/** The Expert's Products: create, read, edit the promise, brief and pricing, delete. */
export class CreatorFactoryService {
  private readonly analytics: ProductAnalytics;

  constructor(
    private readonly repository: CreatorFactoryRepository,
    private readonly graphStore?: DistillationGraphStore,
    analytics?: ProductAnalytics
  ) {
    this.analytics = safely(analytics);
  }

  async createProduct(creatorId: string, input: { name: string; promise?: string; brief?: string; idempotencyKey?: string }): Promise<CreatorProductRecord> {
    const repository = this.productRepository();
    const name = validateProductText(input.name, "product.name", 240);
    const promise = validateProductText(input.promise ?? input.brief ?? "", "product.promise");
    // Product.id is the sole stable identity. Its graph Run is created at the
    // same boundary so Product Files/Snapshots/Revisions can all append to a
    // valid Product-owned lineage, including an idempotent retry after a
    // process died between the repository insert and graph event.
    const productId = randomUUID();
    const product = await repository.createProduct({
      id: productId,
      creatorId: requireText(creatorId, "creatorId"),
      name,
      promise,
      briefSpec: draftBriefSpecForProduct(name, promise),
      runId: productId,
      idempotencyKey: input.idempotencyKey
    });
    if (this.graphStore) {
      await this.graphStore.initialize();
      const distillationRunId = product.runId ?? product.id;
      await this.graphStore.ensureRun({
        id: distillationRunId,
        creatorId: product.creatorId,
        productId: product.id,
        createdAt: product.createdAt
      });
      await this.graphStore.appendEvent({
        id: `evt_${randomUUID().replaceAll("-", "")}`,
        eventKey: `${product.id}:created`,
        productId: product.id,
        runId: distillationRunId,
        type: "product_created",
        node: "intake",
        actor: "creator",
        parentEventIds: [],
        artifactIds: [],
        payload: { nameLength: product.name.length }
      });
    }
    this.analytics.capture(product.creatorId, agentCreated(product.id));
    return product;
  }

  async listProducts(creatorId: string): Promise<CreatorProductRecord[]> {
    return this.productRepository().listProducts(requireText(creatorId, "creatorId"));
  }

  async getProduct(creatorId: string, productId: string): Promise<CreatorProductRecord> {
    const product = await this.productRepository().getProduct(requireText(creatorId, "creatorId"), requireText(productId, "productId"));
    if (!product) throw new CreatorFactoryRepositoryError("run_not_found", `Distillation Product ${productId} was not found`);
    return product;
  }

  async updateProductPromise(
    creatorId: string,
    productId: string,
    input: string | { name?: string; promise: string; expectedUpdatedAt?: string },
    expectedUpdatedAt?: string
  ): Promise<CreatorProductRecord> {
    const product = await this.getProduct(creatorId, productId);
    if (product.status !== "active") throw new CreatorFactoryRepositoryError("invalid_status", `Distillation Product ${productId} is deleted`);
    const promise = typeof input === "string" ? input : input.promise;
    const expected = typeof input === "string" ? expectedUpdatedAt : input.expectedUpdatedAt;
    return this.productRepository().updateProductPromise(creatorId, productId, {
      ...(typeof input !== "string" && input.name !== undefined ? { name: validateProductText(input.name, "product.name", 240) } : {}),
      promise: validateProductText(promise, "product.promise"),
      ...(expected ? { expectedUpdatedAt: expected } : {})
    });
  }

  async saveProductBriefSpec(creatorId: string, productId: string, briefSpec: BriefSpec, expectedUpdatedAt?: string): Promise<CreatorProductRecord> {
    const product = await this.getProduct(creatorId, productId);
    if (product.status !== "active") throw new CreatorFactoryRepositoryError("invalid_status", `Distillation Product ${productId} is deleted`);
    return this.productRepository().saveBriefSpec(creatorId, productId, {
      briefSpec: normalizeBriefSpec(briefSpec),
      ...(expectedUpdatedAt ? { expectedUpdatedAt } : {})
    });
  }

  async saveProductPricing(creatorId: string, productId: string, pricing: unknown, expectedUpdatedAt?: string): Promise<CreatorProductRecord> {
    const product = await this.getProduct(creatorId, productId);
    if (product.status !== "active") throw new CreatorFactoryRepositoryError("invalid_status", `Distillation Product ${productId} is deleted`);
    return this.productRepository().savePricing(creatorId, productId, {
      pricing: normalizeProductPricing(pricing),
      ...(expectedUpdatedAt ? { expectedUpdatedAt } : {})
    });
  }

  async deleteProduct(creatorId: string, productId: string): Promise<CreatorProductRecord> {
    return this.productRepository().softDeleteProduct(requireText(creatorId, "creatorId"), requireText(productId, "productId"));
  }

  private productRepository() {
    if (!isCreatorProductRepository(this.repository)) {
      throw new CreatorFactoryRepositoryError("invalid_status", "Distillation Product storage is unavailable");
    }
    return this.repository;
  }
}

function requireText(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}
