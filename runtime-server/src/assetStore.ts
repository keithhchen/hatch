import { createHash } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MAX_CONTEXT_ASSET_BYTES,
  type AssetAttachment,
  type PersistedContextAttachment
} from "./protocol.js";

const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

export type AssetReference = Omit<AssetAttachment, "data_base64">;

/**
 * Runtime-owned binary asset storage. Conversation JSON contains only an
 * immutable reference; the bytes live below the Runtime data directory and
 * are addressed by the client-supplied content identity after validation.
 */
export class RuntimeAssetStore {
  private readonly root: string;

  constructor(dataDirectory: string) {
    this.root = path.join(dataDirectory, "assets");
  }

  async put(attachment: AssetAttachment): Promise<AssetReference> {
    const target = this.assetPath(attachment.asset_id);
    await mkdir(this.root, { recursive: true });
    if (attachment.data_base64 === undefined) {
      const existing = await readFile(target).catch((error: unknown) => {
        if (isMissingFile(error)) return undefined;
        throw error;
      });
      if (!existing) throw new Error(`Rich asset payload is unavailable: ${attachment.asset_id}`);
      verifyAssetBytes(attachment, existing);
      return persistedAsset(attachment);
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
    return persistedAsset(attachment);
  }

  async read(assetId: string): Promise<Buffer> {
    const target = this.assetPath(assetId);
    const metadata = await stat(target);
    if (!metadata.isFile()) throw new Error(`Runtime asset is not a regular file: ${assetId}`);
    if (metadata.size > MAX_CONTEXT_ASSET_BYTES) {
      throw new Error(`Runtime asset exceeds the ${MAX_CONTEXT_ASSET_BYTES}-byte limit`);
    }
    return readFile(target);
  }

  async readBase64(assetId: string): Promise<string> {
    return (await this.read(assetId)).toString("base64");
  }

  has(assetId: string): Promise<boolean> {
    return stat(this.assetPath(assetId)).then((metadata) => metadata.isFile(), () => false);
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

function persistedAsset(attachment: AssetAttachment): AssetReference {
  const { data_base64: _dataBase64, ...reference } = attachment;
  return reference;
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
  return attachments.map(persistedAsset);
}
