import type { BriefSpec } from "../brief.js";

export type CreatorProductStatus = "active" | "deleted";

export type CreatorProductRecord = {
  /** The sole stable Product identity. A revision never changes this value. */
  id: string;
  creatorId: string;
  name: string;
  /** Creator-facing promise. This is the authoritative value. */
  promise: string;
  /** @deprecated Worker compatibility alias; never serialized by HTTP. */
  brief: string;
  /** Creator-confirmed buyer intake contract. Every Product has one. */
  briefSpec: BriefSpec;
  status: CreatorProductStatus;
  /** Stable DistillationRun lineage. A Product has one; revisions live below it. */
  runId?: string;
  latestRevisionId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type CreateCreatorProductInput = {
  id: string;
  creatorId: string;
  name: string;
  promise: string;
  briefSpec: BriefSpec;
};

export type CreatorProductRepository = {
  createProduct(input: CreateCreatorProductInput): Promise<CreatorProductRecord>;
  getProduct(creatorId: string, productId: string): Promise<CreatorProductRecord | undefined>;
  listProducts(creatorId: string): Promise<CreatorProductRecord[]>;
  updateProductPromise(creatorId: string, productId: string, input: { promise: string; expectedUpdatedAt?: string }): Promise<CreatorProductRecord>;
  saveBriefSpec(creatorId: string, productId: string, input: { briefSpec: BriefSpec; expectedUpdatedAt?: string }): Promise<CreatorProductRecord>;
  softDeleteProduct(creatorId: string, productId: string): Promise<CreatorProductRecord>;
  setProductRevision(creatorId: string, productId: string, input: { runId: string; revisionId: string }): Promise<CreatorProductRecord>;
};

export function isCreatorProductRepository(value: unknown): value is CreatorProductRepository {
  return Boolean(value && typeof value === "object"
    && typeof (value as { createProduct?: unknown }).createProduct === "function"
    && typeof (value as { getProduct?: unknown }).getProduct === "function"
    && typeof (value as { listProducts?: unknown }).listProducts === "function"
    && typeof (value as { updateProductPromise?: unknown }).updateProductPromise === "function"
    && typeof (value as { saveBriefSpec?: unknown }).saveBriefSpec === "function"
    && typeof (value as { softDeleteProduct?: unknown }).softDeleteProduct === "function"
    && typeof (value as { setProductRevision?: unknown }).setProductRevision === "function");
}

export function validateProductText(value: string, label: string, max = 100_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${label} is too long`);
  return normalized;
}
