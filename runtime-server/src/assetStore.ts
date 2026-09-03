import { createHash } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MAX_CONTEXT_ASSET_BYTES,
  type AssetAttachment,
  type PersistedAssetAttachment,
  type PersistedContextAttachment
} from "./protocol.js";
import { AliyunArtifactObjectStore, type ArtifactObjectStore } from "./creatorLearning/objectStore.js";

const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

export type AssetReference = PersistedAssetAttachment & { storage_ref: string };

export type RuntimeAssetStoreOptions = {
  objectStore?: ArtifactObjectStore;
  /** Full object-key prefix inside the configured cloud bucket. */
  objectKeyPrefix?: string;
  storageReferencePrefix?: string;
};

/**
 * Runtime-owned binary asset storage. Conversation JSON contains only an
 * immutable cloud/local reference; the bytes are addressed by the validated
 * asset identity and never embedded in the durable transcript.
 */
export class RuntimeAssetStore {
  private readonly root: string;
  private readonly objectStore?: ArtifactObjectStore;
  private readonly objectKeyPrefix: string;
  private readonly storageReferencePrefix: string;

  constructor(dataDirectory: string, options: RuntimeAssetStoreOptions = {}) {
    this.root = path.join(dataDirectory, "assets");
    this.objectStore = options.objectStore;
    this.objectKeyPrefix = options.objectKeyPrefix?.replace(/^\/+|\/+$/g, "") || "chat-assets";
    this.storageReferencePrefix = options.storageReferencePrefix?.replace(/\/+$/, "")
      || "local://runtime-assets";
  }

  async put(attachment: AssetAttachment): Promise<AssetReference> {
    if (this.objectStore) return this.putObject(attachment);
    const target = this.assetPath(attachment.asset_id);
    await mkdir(this.root, { recursive: true });
    if (attachment.data_base64 === undefined) {
      const existing = await readFile(target).catch((error: unknown) => {
        if (isMissingFile(error)) return undefined;
        throw error;
      });
      if (!existing) throw new Error(`Rich asset payload is unavailable: ${attachment.asset_id}`);
      verifyAssetBytes(attachment, existing);
      return persistedAsset(attachment, this.storageReference(attachment.asset_id));
    }
    const bytes = decodeAsset(attachment);
    try {
      const existing = await readFile(target);
      if (!sameBytes(existing, bytes)) {
        throw new Error(`Asset id already exists with different content: ${attachment.asset_id}`);
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const temporary = path.join(this.root, `.${attachment.asset_id}.${process.pid}.${Date.now()}.tmp`);
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      try {
        // `rename` replaces an existing file on POSIX. A hard-link gives us
        // no-replace publication, so concurrent writers cannot silently
        // change the bytes associated with an already-used asset id.
        await link(temporary, target);
      } catch (linkError) {
        if (isExistingFile(linkError)) {
          const existing = await readFile(target);
          if (!sameBytes(existing, bytes)) {
            throw new Error(`Asset id already exists with different content: ${attachment.asset_id}`);
          }
        } else {
          throw linkError;
        }
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    }
    return persistedAsset(attachment, this.storageReference(attachment.asset_id));
  }

  async read(assetId: string, storageRef?: string): Promise<Buffer> {
    if (this.objectStore) {
      const bytes = await this.objectStore.get(this.objectKey(assetId, storageRef));
      if (bytes.byteLength > MAX_CONTEXT_ASSET_BYTES) {
        throw new Error(`Runtime asset exceeds the ${MAX_CONTEXT_ASSET_BYTES}-byte limit`);
      }
      return bytes;
    }
    const target = this.assetPath(assetId);
    const metadata = await stat(target);
    if (!metadata.isFile()) throw new Error(`Runtime asset is not a regular file: ${assetId}`);
    if (metadata.size > MAX_CONTEXT_ASSET_BYTES) {
      throw new Error(`Runtime asset exceeds the ${MAX_CONTEXT_ASSET_BYTES}-byte limit`);
    }
    return readFile(target);
  }

  async readBase64(assetId: string, storageRef?: string): Promise<string> {
    return (await this.read(assetId, storageRef)).toString("base64");
  }

  has(assetId: string): Promise<boolean> {
    if (this.objectStore) {
      return this.objectStore.get(this.objectKey(assetId)).then(() => true, () => false);
    }
    return stat(this.assetPath(assetId)).then((metadata) => metadata.isFile(), () => false);
  }

  private async putObject(attachment: AssetAttachment): Promise<AssetReference> {
    const key = this.objectKey(attachment.asset_id);
    const bytes = attachment.data_base64 === undefined
      ? await this.objectStore!.get(key)
      : decodeAsset(attachment);
    verifyAssetBytes(attachment, bytes);
    await this.objectStore!.put(key, bytes, {
      contentType: attachment.media_type,
      metadata: {
        attachment_id: attachment.attachment_id,
        sha256: attachment.sha256
      },
      immutable: true
    });
    return persistedAsset(attachment, this.storageReference(attachment.asset_id));
  }

  private objectKey(assetId: string, storageRef?: string): string {
    if (!ASSET_ID_PATTERN.test(assetId)) throw new Error("Invalid Runtime asset id");
    if (storageRef && this.objectStore) {
      const match = storageRef.match(/^oss:\/\/[^/]+\/(.+)$/);
      const persistedKey = match?.[1];
      if (!persistedKey
        || persistedKey.split("/").some((part) => !part || part === "." || part === "..")
        || !persistedKey.endsWith(`/${assetId}`)) {
        throw new Error(`Invalid Runtime cloud asset reference: ${assetId}`);
      }
      return persistedKey;
    }
    return `${this.objectKeyPrefix}/${assetId}`;
  }

  private storageReference(assetId: string): string {
    return `${this.storageReferencePrefix}/${this.objectStore ? this.objectKey(assetId) : `${assetId}.bin`}`;
  }

  private assetPath(assetId: string): string {
    if (!ASSET_ID_PATTERN.test(assetId)) throw new Error("Invalid Runtime asset id");
    return path.join(this.root, `${assetId}.bin`);
  }
}

function decodeAsset(attachment: AssetAttachment): Buffer {
  if (attachment.data_base64 === undefined) {
    throw new Error(`Rich asset payload is unavailable: ${attachment.asset_id}`);
  }
  const bytes = Buffer.from(attachment.data_base64, "base64");
  verifyAssetBytes(attachment, bytes);
  return bytes;
}

function verifyAssetBytes(attachment: AssetAttachment, bytes: Uint8Array): void {
  if (bytes.length !== attachment.source_bytes || bytes.length > MAX_CONTEXT_ASSET_BYTES) {
    throw new Error(`Rich asset byte count does not match its declared size: ${attachment.asset_id}`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== attachment.sha256) throw new Error(`Rich asset digest mismatch: ${attachment.asset_id}`);
}

function persistedAsset(attachment: AssetAttachment, storageRef: string): AssetReference {
  const { data_base64: _dataBase64, ...reference } = attachment;
  return { ...reference, storage_ref: storageRef };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isExistingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

export function persistedAttachments(attachments: AssetAttachment[]): PersistedContextAttachment[] {
  return attachments.map((attachment) => persistedAsset(attachment, `local://runtime-assets/${attachment.asset_id}.bin`));
}

/**
 * Production Runtime assets use the same private Alibaba OSS contract as the
 * Creator artifact store, but under a dedicated runtime-assets prefix. Local
 * development keeps the filesystem implementation explicit and deterministic.
 */
export function runtimeAssetStoreFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  dataDirectory = environment.HATCH_RUNTIME_DATA_DIR?.trim() || path.resolve(".hatch-runtime")
): RuntimeAssetStore {
  const bucket = environment.HATCH_RUNTIME_OBJECT_STORE_BUCKET?.trim()
    || environment.HATCH_CREATOR_OBJECT_STORE_BUCKET?.trim();
  if (!bucket) {
    if (environment.NODE_ENV === "production") {
      throw new Error("HATCH_RUNTIME_OBJECT_STORE_BUCKET or HATCH_CREATOR_OBJECT_STORE_BUCKET is required in production");
    }
    return new RuntimeAssetStore(dataDirectory);
  }
  const configuredCreatorPrefix = environment.HATCH_CREATOR_OBJECT_STORE_PREFIX?.trim() || "hatch";
  const prefix = environment.HATCH_RUNTIME_OBJECT_STORE_PREFIX?.trim()
    || `${configuredCreatorPrefix}/runtime-assets`;
  const region = environment.HATCH_RUNTIME_OBJECT_STORE_REGION?.trim()
    || environment.HATCH_CREATOR_OBJECT_STORE_REGION?.trim()
    || "oss-cn-shanghai";
  const endpoint = environment.HATCH_RUNTIME_OBJECT_STORE_ENDPOINT?.trim()
    || environment.HATCH_CREATOR_OBJECT_STORE_ENDPOINT?.trim();
  const internalRaw = environment.HATCH_RUNTIME_OBJECT_STORE_INTERNAL
    ?? environment.HATCH_CREATOR_OBJECT_STORE_INTERNAL;
  const internal = internalRaw === undefined ? true : internalRaw.trim().toLowerCase() === "true";
  return new RuntimeAssetStore(dataDirectory, {
    objectStore: new AliyunArtifactObjectStore({
      bucket,
      region,
      ...(endpoint ? { endpoint } : {}),
      internal,
      // RuntimeAssetStore supplies the complete key so the persisted
      // storage_ref remains readable if the configured prefix changes.
      prefix: ""
    }),
    objectKeyPrefix: prefix,
    storageReferencePrefix: `oss://${bucket}`
  });
}
