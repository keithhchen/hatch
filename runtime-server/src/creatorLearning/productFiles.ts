import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { projectSource, detectMediaType, SOURCE_DOCUMENT_MAX_BYTES } from "./sourceLibrary.js";
import type { FactorySource, SourceProjection } from "./types.js";
import { isObjectStoreNotFound, type ArtifactObjectStore } from "./objectStore.js";
import { normalizeNodeObjectPath } from "../node.js";

/**
 * A Product File path is an OSS object key, not a local filesystem path. The
 * three scope segments before `files` are prefix/creator/product; the last
 * three are the immutable file projection address.
 */
export function isCanonicalProductFileProjectionPath(value: string): boolean {
  try {
    const parts = normalizeNodeObjectPath(value).split("/");
    const filesIndex = parts.length - 3;
    return filesIndex >= 3
      && parts[filesIndex] === "files"
      && /^[A-Za-z0-9._-]+$/.test(parts[filesIndex - 2] ?? "")
      && /^[A-Za-z0-9._-]+$/.test(parts[filesIndex - 1] ?? "")
      && /^file_[A-Za-z0-9_-]{1,160}$/.test(parts[filesIndex + 1] ?? "")
      && (parts[filesIndex + 2] ?? "") === "projection.md";
  } catch {
    return false;
  }
}

/** Node input contract for Product-owned source attachments. */
export const productFileProjectionPathSchema = z.string()
  .min(1)
  .max(512)
  .refine(isCanonicalProductFileProjectionPath, "must be a canonical Product File projection path");

/**
 * Product-owned source material. Files are intentionally independent from a
 * Version/Run: a Version records a locked ProductSnapshot that points at
 * these immutable file artifacts.
 */
export type ProductFileRecord = {
  id: string;
  artifactId: string;
  creatorId: string;
  productId: string;
  displayName: string;
  mediaType: string;
  originalObjectRef: string;
  originalSha256: string;
  originalBytes: number;
  projection: SourceProjection;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ProductSnapshotRecord = {
  id: string;
  creatorId: string;
  productId: string;
  version: number;
  fileIds: string[];
  files: Array<Pick<ProductFileRecord, "id" | "artifactId" | "displayName" | "mediaType" | "originalSha256" | "projection">>;
  manifestSha256: string;
  lockedAt: string;
  createdAt: string;
};

export type ProductFileView = ProductFileRecord & {
  projectionContent?: string;
  projectionBase64?: string;
  deletedAt?: string;
};

export type ProductSnapshotView = ProductSnapshotRecord & {
  documents: ProductFileView[];
};

export class ProductFilesError extends Error {
  constructor(
    readonly code:
      | "product_file_not_found"
      | "product_snapshot_not_found"
      | "invalid_product_file"
      | "invalid_product_snapshot"
      | "product_mismatch"
      | "idempotency_conflict"
      | "unsupported_media_type"
      | "projection_failed",
    message: string
  ) {
    super(message);
    this.name = "ProductFilesError";
  }
}

export class ProductFileStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly objectStore: ArtifactObjectStore,
    private readonly prefix = "creator-products"
  ) {}

  async createFromUpload(input: {
    creatorId: string;
    productId: string;
    displayName: string;
    mediaType?: string;
    bytes: Buffer;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<ProductFileView> {
    return this.write(async () => {
      const creatorId = requireText(input.creatorId, "creatorId");
      const productId = requireText(input.productId, "productId");
      const displayName = safeDisplayName(input.displayName);
      if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) {
        throw invalidFile("Uploaded file is empty");
      }
      if (input.bytes.length > SOURCE_DOCUMENT_MAX_BYTES) {
        throw invalidFile(`Uploaded file exceeds ${SOURCE_DOCUMENT_MAX_BYTES} bytes`);
      }
      const mediaType = detectMediaType(displayName, input.mediaType, input.bytes);
      if (mediaType.startsWith("image/") || IMAGE_FILENAME_RE.test(displayName)) {
        throw new ProductFilesError(
          "unsupported_media_type",
          "Images are not supported in Files yet. Upload a PDF, Office document, or text file."
        );
      }
      if (LEGACY_OFFICE_FILENAME_RE.test(displayName) || LEGACY_OFFICE_MEDIA_TYPES.has(mediaType)) {
        throw new ProductFilesError(
          "unsupported_media_type",
          "Legacy .doc and .ppt files are not supported yet. Save them as .docx or .pptx before uploading."
        );
      }
      let projection: SourceProjection;
      try {
        projection = await projectSource(displayName, mediaType, input.bytes);
      } catch (error) {
        if (error instanceof Error && error.name === "CreatorSourceLibraryError") {
          throw new ProductFilesError("projection_failed", error.message);
        }
        throw new ProductFilesError("projection_failed", `Could not prepare ${displayName}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (projection.kind !== "markdown" || projection.mediaType !== "text/markdown") {
        throw new ProductFilesError(
          "projection_failed",
          "Every supported Product File must be converted to Markdown before it is stored"
        );
      }
      const projectionText = (projection as SourceProjection & { __content?: string }).__content;
      if (typeof projectionText !== "string") {
        throw new ProductFilesError("projection_failed", `Could not prepare ${displayName} as Markdown`);
      }
      const originalSha256 = digest(input.bytes);
      const metadata = sanitizeMetadata(input.metadata);
      const requestDigest = uploadRequestDigest({ displayName, mediaType, originalSha256, originalBytes: input.bytes.length, metadata });
      const idempotencyReceipt = input.idempotencyKey?.trim()
        ? this.idempotencyRef(creatorId, productId, "file", input.idempotencyKey)
        : undefined;
      if (idempotencyReceipt) {
        const existing = await this.readIdempotencyReceipt(idempotencyReceipt);
        if (existing) {
          if (existing.requestDigest !== requestDigest) {
            throw new ProductFilesError("idempotency_conflict", "Idempotency-Key was already used for a different Product File");
          }
          return this.getFileUnsafe(creatorId, productId, existing.resourceId);
        }
      }
      // The bytes are the immutable artifact identity, while the file record
      // also carries creator-facing metadata. Include the complete normalized
      // record identity so the same bytes can be intentionally captured again
      // when its provenance metadata changes.
      const fileIdentity = createHash("sha256")
        .update(`${originalSha256}\u0000${displayName}\u0000${mediaType}\u0000${JSON.stringify(canonicalize(metadata))}`)
        .digest("hex");
      const fileId = `file_${fileIdentity.slice(0, 40)}`;
      const artifactId = `artifact_${originalSha256}`;
      const base = this.filePrefix(creatorId, productId, fileId);
      const originalObjectRef = `${base}/original.bin`;
      const projectionObjectRef = `${base}/projection.md`;
      const createdAt = new Date().toISOString();
      const storedProjection: SourceProjection = {
        kind: "markdown",
        mediaType: "text/markdown",
        contentRef: projectionObjectRef,
        sha256: projection.sha256,
        bytes: projection.bytes
      };
      const record: ProductFileRecord = {
        id: fileId,
        artifactId,
        creatorId,
        productId,
        displayName,
        mediaType,
        originalObjectRef,
        originalSha256,
        originalBytes: input.bytes.length,
        projection: storedProjection,
        metadata,
        createdAt,
        updatedAt: createdAt
      };
      // Deterministic content-addressed file ids make retries and repeated
      // Idempotency-Key submissions return the same immutable artifact.
      await this.objectStore.put(originalObjectRef, input.bytes, { contentType: mediaType, immutable: true });
      await this.objectStore.put(
        projectionObjectRef,
        Buffer.from(projectionText, "utf8"),
        { contentType: "text/markdown; charset=utf-8", immutable: true }
      );
      try {
        await this.objectStore.put(`${base}/file.json`, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"), {
          contentType: "application/json; charset=utf-8",
          immutable: true
        });
      } catch (error) {
        // The content-addressed object may already exist from a completed
        // retry. A different record at the same key is a true idempotency
        // conflict, not an internal server error.
        if (error instanceof Error && error.message.includes("Immutable object key already contains different bytes")) {
          const existing = await this.findRecordUnsafe(creatorId, productId, fileId);
          const existingDigest = uploadRequestDigest({
            displayName: existing.displayName,
            mediaType: existing.mediaType,
            originalSha256: existing.originalSha256,
            originalBytes: existing.originalBytes,
            metadata: existing.metadata
          });
          if (existingDigest === requestDigest) {
            await this.restoreFileIfDeleted(existing);
            if (idempotencyReceipt) {
              await this.writeIdempotencyReceipt(idempotencyReceipt, { requestDigest, resourceId: fileId });
            }
            return this.withProjectionContent(existing);
          }
          throw new ProductFilesError("idempotency_conflict", "Product File identity already contains different metadata");
        }
        throw error;
      }
      if (idempotencyReceipt) {
        await this.writeIdempotencyReceipt(idempotencyReceipt, {
          requestDigest,
          resourceId: fileId
        });
      }
      return this.withProjectionContent(record);
    });
  }

  async listFiles(creatorId: string, productId: string): Promise<ProductFileView[]> {
    await this.writeChain;
    return this.listFilesUnsafe(creatorId, productId);
  }

  /**
   * The only supported way for a Node launcher to turn Product File ids into
   * Node input paths. Callers never reconstruct the OSS key from an id.
   */
  async listProjectionPaths(creatorId: string, productId: string, fileIds?: string[]): Promise<string[]> {
    await this.writeChain;
    const files = await this.listFilesUnsafe(creatorId, productId);
    const selectedIds = fileIds?.length
      ? [...new Set(fileIds.map((id) => safeId(id)))]
      : files.map((file) => file.id);
    const byId = new Map(files.map((file) => [file.id, file]));
    const selected = selectedIds.map((id) => byId.get(id));
    if (selected.some((file) => !file)) {
      throw new ProductFilesError("product_file_not_found", "A Node input can contain only Files from this Product");
    }
    const selectedFiles = selected as ProductFileView[];
    if (selectedFiles.some((file) => file.projection.kind !== "markdown")) {
      throw new ProductFilesError(
        "unsupported_media_type",
        "Images are not supported as Node input yet. Remove them or upload text-based source material."
      );
    }
    return selectedFiles.map((file) => file.projection.contentRef);
  }

  private async listFilesUnsafe(creatorId: string, productId: string): Promise<ProductFileView[]> {
    const names = (await this.objectStore.list(this.productPrefix(creatorId, productId)))
      .filter((name) => name.endsWith("/file.json"));
    const records = await Promise.all(names.map((name) => this.readRecord(name)));
    const activeRecords = (await Promise.all(records.map(async (record) => ({
      record,
      lifecycle: await this.readLifecycleStatus(record)
    })))).filter(({ lifecycle }) => !lifecycle?.deletedAt);
    return Promise.all(activeRecords
      .map(({ record }) => record)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
      .map((record) => this.withProjectionContent(record)));
  }

  async getFile(creatorId: string, productId: string, fileId: string): Promise<ProductFileView> {
    await this.writeChain;
    return this.getFileUnsafe(creatorId, productId, fileId);
  }

  /**
   * Hide a Product File from future Node inputs without deleting any OSS
   * object. The immutable event is the audit record; status.json is the only
   * mutable object and makes the file list cheap to read.
   */
  async deleteFile(creatorId: string, productId: string, fileId: string): Promise<ProductFileView> {
    return this.write(async () => {
      const record = await this.findRecordUnsafe(creatorId, productId, fileId);
      const existing = await this.readLifecycleStatus(record);
      if (existing?.deletedAt) {
        throw new ProductFilesError("product_file_not_found", `Product File ${fileId} was not found`);
      }
      const deletedAt = new Date().toISOString();
      const base = this.filePrefix(creatorId, productId, record.id);
      await this.objectStore.put(`${base}/lifecycle/deleted-${Date.now()}-${randomUUID()}.json`, Buffer.from(`${JSON.stringify({
        event: "deleted",
        file_id: record.id,
        deleted_at: deletedAt
      })}\n`, "utf8"), {
        contentType: "application/json; charset=utf-8",
        immutable: true
      });
      await this.objectStore.put(this.lifecycleStatusRef(record), Buffer.from(`${JSON.stringify({
        status: "deleted",
        deleted_at: deletedAt,
        updated_at: deletedAt
      })}\n`, "utf8"), {
        contentType: "application/json; charset=utf-8",
        immutable: false
      });
      return this.withProjectionContent(record, deletedAt);
    });
  }

  private async getFileUnsafe(creatorId: string, productId: string, fileId: string): Promise<ProductFileView> {
    const record = await this.findRecordUnsafe(creatorId, productId, fileId);
    if ((await this.readLifecycleStatus(record))?.deletedAt) {
      throw new ProductFilesError("product_file_not_found", `Product File ${fileId} was not found`);
    }
    return this.withProjectionContent(record);
  }

  private async findRecordUnsafe(creatorId: string, productId: string, fileId: string): Promise<ProductFileRecord> {
    const safeFile = safeId(fileId);
    const names = (await this.objectStore.list(this.productPrefix(creatorId, productId)))
      .filter((name) => name.endsWith("/file.json") && name.includes(`/${safeFile}/`));
    if (!names.length) throw new ProductFilesError("product_file_not_found", `Product File ${fileId} was not found`);
    const record = await this.readRecord(names[0]!);
    if (record.creatorId !== creatorId || record.productId !== productId) {
      throw new ProductFilesError("product_mismatch", "Product File belongs to another Product");
    }
    return record;
  }

  async createSnapshot(creatorId: string, productId: string, fileIds?: string[], idempotencyKey?: string): Promise<ProductSnapshotView> {
    return this.write(async () => {
      const files = await this.listFilesUnsafe(creatorId, productId);
      const selectedIds = fileIds?.length ? [...new Set(fileIds.map((id) => safeId(id)))] : files.map((file) => file.id);
      if (!selectedIds.length) throw new ProductFilesError("invalid_product_snapshot", "A Product Snapshot needs at least one File");
      const byId = new Map(files.map((file) => [file.id, file]));
      const selected = selectedIds.map((id) => byId.get(id));
      if (selected.some((file) => !file)) throw new ProductFilesError("product_file_not_found", "A Product Snapshot can contain only Files from this Product");
      const normalized = selected as ProductFileView[];
      const requestDigest = digestText(JSON.stringify({
        productId,
        fileIds: normalized.map((file) => file.id),
        fileDigests: normalized.map((file) => file.originalSha256)
      }));
      const idempotencyReceipt = idempotencyKey?.trim()
        ? this.idempotencyRef(creatorId, productId, "snapshot", idempotencyKey)
        : undefined;
      if (idempotencyReceipt) {
        const existing = await this.readIdempotencyReceipt(idempotencyReceipt);
        if (existing) {
          if (existing.requestDigest !== requestDigest) {
            throw new ProductFilesError("idempotency_conflict", "Idempotency-Key was already used for a different Product Snapshot");
          }
          return this.getSnapshotUnsafe(creatorId, productId, existing.resourceId);
        }
      }
      const version = await this.nextSnapshotVersionUnsafe(creatorId, productId);
      const lockedAt = new Date().toISOString();
      const manifest = {
        contractVersion: "product-snapshot-v1",
        creatorId,
        productId,
        version,
        files: normalized.map((file) => ({
          id: file.id,
          artifactId: file.artifactId,
          displayName: file.displayName,
          mediaType: file.mediaType,
          originalSha256: file.originalSha256,
          projection: file.projection
        }))
      };
      const manifestSha256 = digest(Buffer.from(JSON.stringify(manifest), "utf8"));
      const record: ProductSnapshotRecord = {
        id: `snapshot_${randomUUID().replaceAll("-", "")}`,
        creatorId,
        productId,
        version,
        fileIds: normalized.map((file) => file.id),
        files: normalized.map((file) => ({
          id: file.id,
          artifactId: file.artifactId,
          displayName: file.displayName,
          mediaType: file.mediaType,
          originalSha256: file.originalSha256,
          projection: file.projection
        })),
        manifestSha256,
        lockedAt,
        createdAt: lockedAt
      };
      const key = `${this.productPrefix(creatorId, productId)}/snapshots/${record.id}.json`;
      await this.objectStore.put(key, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"), {
        contentType: "application/json; charset=utf-8",
        immutable: true
      });
      if (idempotencyReceipt) {
        await this.writeIdempotencyReceipt(idempotencyReceipt, {
          requestDigest,
          resourceId: record.id
        });
      }
      return { ...record, documents: normalized };
    });
  }

  async listSnapshots(creatorId: string, productId: string): Promise<ProductSnapshotRecord[]> {
    await this.writeChain;
    return this.listSnapshotsUnsafe(creatorId, productId);
  }

  private async listSnapshotsUnsafe(creatorId: string, productId: string): Promise<ProductSnapshotRecord[]> {
    const names = (await this.objectStore.list(`${this.productPrefix(creatorId, productId)}/snapshots`))
      .filter((name) => name.endsWith(".json"));
    const records = await Promise.all(names.map(async (name) => JSON.parse((await this.objectStore.get(name)).toString("utf8")) as ProductSnapshotRecord));
    return records.sort((left, right) => right.version - left.version || right.createdAt.localeCompare(left.createdAt));
  }

  async getSnapshot(creatorId: string, productId: string, snapshotId: string): Promise<ProductSnapshotView> {
    await this.writeChain;
    return this.getSnapshotUnsafe(creatorId, productId, snapshotId);
  }

  private async getSnapshotUnsafe(creatorId: string, productId: string, snapshotId: string): Promise<ProductSnapshotView> {
    const name = `${this.productPrefix(creatorId, productId)}/snapshots/${safeId(snapshotId)}.json`;
    let record: ProductSnapshotRecord;
    try {
      record = JSON.parse((await this.objectStore.get(name)).toString("utf8")) as ProductSnapshotRecord;
    } catch (error) {
      if (isMissingObject(error)) {
        throw new ProductFilesError("product_snapshot_not_found", `Product Snapshot ${snapshotId} was not found`);
      }
      if (error instanceof SyntaxError) {
        throw new ProductFilesError("invalid_product_snapshot", `Product Snapshot ${snapshotId} metadata is invalid`);
      }
      throw error;
    }
    if (record.creatorId !== creatorId || record.productId !== productId) {
      throw new ProductFilesError("product_mismatch", "Product Snapshot belongs to another Product");
    }
    const documents = await Promise.all(record.fileIds.map((id) => this.getFileUnsafe(creatorId, productId, id)));
    return { ...record, documents };
  }

  async resolveSnapshotSources(creatorId: string, productId: string, snapshotId: string): Promise<FactorySource[]> {
    const snapshot = await this.getSnapshot(creatorId, productId, snapshotId);
    return Promise.all(snapshot.documents.map(async (file, index) => {
      if (file.projection.kind === "image") {
        const bytes = await this.objectStore.get(file.projection.contentRef);
        return {
          id: `S${index + 1}`,
          authority: "private_material" as const,
          title: file.displayName,
          content: `[Native image source: ${file.displayName}]`,
          image: { mediaType: file.projection.mediaType, base64: bytes.toString("base64"), sha256: file.projection.sha256 }
        };
      }
      return {
        id: `S${index + 1}`,
        authority: "private_material" as const,
        title: file.displayName,
        content: (await this.objectStore.get(file.projection.contentRef)).toString("utf8")
      };
    }));
  }

  private async nextSnapshotVersionUnsafe(creatorId: string, productId: string): Promise<number> {
    const records = await this.listSnapshotsUnsafe(creatorId, productId);
    return Math.max(0, ...records.map((record) => Number(record.version) || 0)) + 1;
  }

  private async readRecord(name: string): Promise<ProductFileRecord> {
    let record: ProductFileRecord;
    try {
      record = JSON.parse((await this.objectStore.get(name)).toString("utf8")) as ProductFileRecord;
    } catch (error) {
      if (error instanceof SyntaxError) throw invalidFile("Product File metadata is invalid");
      throw error;
    }
    if (
      !record
      || typeof record.id !== "string"
      || typeof record.creatorId !== "string"
      || typeof record.productId !== "string"
      || !record.projection
      || typeof record.projection.contentRef !== "string"
    ) {
      throw invalidFile("Product File metadata is invalid");
    }
    const expectedProjectionRef = this.canonicalProjectionRef(record);
    if (record.projection.contentRef !== expectedProjectionRef) {
      throw invalidFile(`Product File ${record.id} has a non-canonical projection path`);
    }
    return record;
  }

  private async withProjectionContent(record: ProductFileRecord, deletedAt?: string): Promise<ProductFileView> {
    const bytes = await this.objectStore.get(record.projection.contentRef);
    return record.projection.kind === "image"
      ? { ...record, projectionBase64: bytes.toString("base64"), ...(deletedAt ? { deletedAt } : {}) }
      : { ...record, projectionContent: bytes.toString("utf8"), ...(deletedAt ? { deletedAt } : {}) };
  }

  private lifecycleStatusRef(record: Pick<ProductFileRecord, "creatorId" | "productId" | "id">): string {
    return `${this.filePrefix(record.creatorId, record.productId, record.id)}/lifecycle/status.json`;
  }

  private async readLifecycleStatus(record: Pick<ProductFileRecord, "creatorId" | "productId" | "id">): Promise<{ deletedAt?: string } | undefined> {
    try {
      const value = JSON.parse((await this.objectStore.get(this.lifecycleStatusRef(record))).toString("utf8")) as Record<string, unknown>;
      if (value.status === "deleted" && typeof value.deleted_at === "string") return { deletedAt: value.deleted_at };
      return undefined;
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      if (error instanceof SyntaxError) throw invalidFile("Product File lifecycle metadata is invalid");
      throw error;
    }
  }

  private async restoreFileIfDeleted(record: ProductFileRecord): Promise<void> {
    const existing = await this.readLifecycleStatus(record);
    if (!existing?.deletedAt) return;
    const restoredAt = new Date().toISOString();
    await this.objectStore.put(this.lifecycleStatusRef(record), Buffer.from(`${JSON.stringify({
      status: "active",
      restored_at: restoredAt,
      updated_at: restoredAt
    })}\n`, "utf8"), {
      contentType: "application/json; charset=utf-8",
      immutable: false
    });
  }

  private idempotencyRef(creatorId: string, productId: string, resource: "file" | "snapshot", key: string): string {
    const keyDigest = digestText(`${creatorId}\u0000${productId}\u0000${resource}\u0000${key.trim()}`);
    return `${this.productPrefix(creatorId, productId)}/idempotency/${resource}-${keyDigest}.json`;
  }

  private async readIdempotencyReceipt(ref: string): Promise<{ requestDigest: string; resourceId: string } | undefined> {
    try {
      const receipt = JSON.parse((await this.objectStore.get(ref)).toString("utf8")) as Record<string, unknown>;
      if (typeof receipt.requestDigest !== "string" || typeof receipt.resourceId !== "string") {
        throw new ProductFilesError("invalid_product_file", "Product idempotency receipt is invalid");
      }
      return { requestDigest: receipt.requestDigest, resourceId: receipt.resourceId };
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      throw error;
    }
  }

  private async writeIdempotencyReceipt(ref: string, value: { requestDigest: string; resourceId: string }): Promise<void> {
    await this.objectStore.put(ref, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"), {
      contentType: "application/json; charset=utf-8",
      immutable: true
    });
  }

  private productPrefix(creatorId: string, productId: string): string {
    return `${this.prefix}/${safePathPart(creatorId)}/${safePathPart(productId)}`;
  }

  private filePrefix(creatorId: string, productId: string, fileId: string): string {
    return `${this.productPrefix(creatorId, productId)}/files/${safePathPart(fileId)}`;
  }

  private canonicalProjectionRef(record: Pick<ProductFileRecord, "creatorId" | "productId" | "id" | "projection">): string {
    return `${this.filePrefix(record.creatorId, record.productId, record.id)}/projection.${projectionFileExtension(record.projection)}`;
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(operation);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }
}

function projectionFileExtension(projection: SourceProjection): string {
  if (projection.kind === "markdown" && projection.mediaType === "text/markdown") return "md";
  throw invalidFile("Product File projection metadata is invalid");
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestText(value: string): string {
  return digest(Buffer.from(value, "utf8"));
}

function uploadRequestDigest(input: {
  displayName: string;
  mediaType: string;
  originalSha256: string;
  originalBytes: number;
  metadata: Record<string, unknown>;
}): string {
  return digestText(JSON.stringify({
    displayName: input.displayName,
    mediaType: input.mediaType,
    originalSha256: input.originalSha256,
    originalBytes: input.originalBytes,
    metadata: canonicalize(input.metadata)
  }));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function isMissingObject(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ENOENT")
    || isObjectStoreNotFound(error);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalidFile(`${field} is required`);
  return value.trim();
}

function safeDisplayName(value: string): string {
  const normalized = requireText(value, "displayName").replace(/[\\/\u0000-\u001F]/g, " ").trim();
  if (!normalized || normalized.length > 240) throw invalidFile("displayName must be 1-240 characters");
  return normalized;
}

const IMAGE_FILENAME_RE = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?)$/i;
const LEGACY_OFFICE_FILENAME_RE = /\.(?:doc|ppt)$/i;
const LEGACY_OFFICE_MEDIA_TYPES = new Set(["application/msword", "application/vnd.ms-powerpoint"]);

function safeId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw invalidFile("Invalid Product File or Snapshot id");
  return value;
}

function safePathPart(value: string): string {
  const normalized = requireText(value, "path").replaceAll("\\", "_").replaceAll("/", "_");
  if (!/^[A-Za-z0-9_.-]{1,200}$/.test(normalized)) throw invalidFile("Invalid Product storage identity");
  return normalized;
}

function sanitizeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(key)) continue;
    if (["string", "number", "boolean"].includes(typeof entry) || entry === null) result[key] = entry;
  }
  return result;
}

function invalidFile(message: string): ProductFilesError {
  return new ProductFilesError("invalid_product_file", message);
}
