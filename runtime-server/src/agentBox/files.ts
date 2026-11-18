import { createHash } from "node:crypto";
import path from "node:path";
import { Asset, scopeKey, type AssetBlobs, type AssetRepository, type AssetScope } from "../assets/domain.js";

export type BuyerScope = Extract<AssetScope, { kind: "buyer" }>;

/** A file kept for a buyer of a Product: what a tool hands back and what other tools take, by id. */
export type SavedFile = { id: string; name: string; mime: string; bytes: number };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".json": "application/json", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml"
};
export const mimeOf = (name: string): string => MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";

/** Where a file's bytes are, under its scope: the same layout uploaded attachments use. */
export const originalKey = (scope: AssetScope, sha256: string): string => `${scopeKey(scope)}/${sha256}/original`;

const view = (asset: Asset): SavedFile => ({ id: asset.id, name: asset.record.name, mime: asset.record.mime, bytes: asset.record.bytes });

/**
 * The buyer's files: content in object storage, a record in the asset table. One record per content in a scope, so saving the
 * same bytes again gives the same id; a crash between the two writes leaves a `processing` record that the next save finishes.
 */
export class BuyerFiles {
  constructor(private readonly repository: AssetRepository, private readonly blobs: AssetBlobs) {}

  async save(scope: BuyerScope, name: string, bytes: Buffer): Promise<SavedFile> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const mime = mimeOf(name);
    const { asset } = await this.repository.insertIfAbsent(Asset.received({ scope, sha256, kind: mime.startsWith("image/") ? "image" : "file", mime, name, bytes: bytes.length }));
    if (asset.state === "ready") return view(asset);
    await this.blobs.put(originalKey(scope, sha256), bytes, { contentType: mime });
    const ready = await this.repository.transition("processing", asset.ready([]));
    return view(ready ?? (await this.repository.get(scope, asset.id))!);
  }

  /** The file with this id in this scope, or undefined: another buyer's id is not found, not refused. */
  async find(scope: BuyerScope, id: string): Promise<SavedFile | undefined> {
    const asset = await this.repository.get(scope, id);
    return asset?.state === "ready" ? view(asset) : undefined;
  }

  async content(scope: BuyerScope, id: string): Promise<Buffer | undefined> {
    const asset = await this.repository.get(scope, id);
    return asset?.state === "ready" ? this.blobs.get(originalKey(scope, asset.record.sha256)) : undefined;
  }
}
