import { createHash } from "node:crypto";
import {
  Asset, AssetError, scopeKey, type AssetBlobs, type AssetKind, type AssetRepository, type AssetScope, type ContentModerator, type Derivative, type ReadyAssetResolver
} from "./domain.js";
import type { AssetProcessor } from "./processors.js";
import { sniff } from "./sniff.js";

export const MAX_BYTES: Record<AssetKind, number> = { image: 20 * 1024 * 1024, file: 50 * 1024 * 1024, audio: 20 * 1024 * 1024 };

/** The name is display text only; storage keys never contain it. */
const displayName = (name: string) => name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) || "file";

const failure = (error: unknown) => error instanceof AssetError
  ? { code: error.code, message: error.message }
  : { code: "processing_failed", message: error instanceof Error ? error.message : String(error) };

/**
 * Upload first, reference by assetId. accept() ends `ready` or a real `failed`;
 * input that must never be stored (too large, unknown type, unsafe archive) is
 * rejected before anything is written.
 */
export class AssetPipeline implements ReadyAssetResolver {
  private readonly processors: Map<AssetKind, AssetProcessor>;
  constructor(
    private readonly repository: AssetRepository,
    private readonly blobs: AssetBlobs,
    private readonly moderator: ContentModerator,
    processors: AssetProcessor[],
    /** An asset still `processing` after `leaseMs` was abandoned by a crash: the next upload of its bytes takes over. */
    private readonly lease: { leaseMs: number; now: () => Date } = { leaseMs: 10 * 60_000, now: () => new Date() }
  ) {
    this.processors = new Map(processors.map(p => [p.kind, p]));
  }

  async accept(scope: AssetScope, input: { name: string; bytes: Buffer }): Promise<Asset> {
    const name = displayName(input.name);
    const sniffed = sniff(input.bytes, name);
    if (input.bytes.length > MAX_BYTES[sniffed.kind]) throw new AssetError("too_large", `${sniffed.kind} exceeds ${MAX_BYTES[sniffed.kind]} bytes`);
    const processor = this.processors.get(sniffed.kind);
    if (!processor) throw new AssetError("unsupported_type", `No processor for ${sniffed.kind}`);

    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const { asset, created } = await this.repository.insertIfAbsent(Asset.received({ scope, sha256, kind: sniffed.kind, mime: sniffed.mime, name, bytes: input.bytes.length }));
    if (!created) return this.abandoned(asset) ? this.reclaim(asset, scope, input) : asset;

    const prefix = `${scopeKey(scope)}/${sha256}`;
    try {
      await this.blobs.put(`${prefix}/original`, input.bytes, { contentType: sniffed.mime });
      const processed = await processor.process({ name, bytes: input.bytes, sniffed });
      const verdict = await this.moderator.check(processed.moderate);
      if (!verdict.allowed) throw new AssetError("moderation_blocked", verdict.reason);
      const derivatives: Derivative[] = [];
      for (const output of processed.outputs) {
        const key = `${prefix}/${output.role}`;
        await this.blobs.put(key, output.bytes, { contentType: output.mime });
        derivatives.push({ role: output.role, key, bytes: output.bytes.length, mime: output.mime, ...(output.truncated ? { truncated: true } : {}) });
      }
      return await this.finish(asset, a => a.ready(derivatives, processed.transcript));
    } catch (error) {
      return this.finish(asset, a => a.failed(failure(error)));
    }
  }

  private abandoned(asset: Asset): boolean {
    return asset.state === "processing" && this.lease.now().getTime() - Date.parse(asset.record.createdAt) > this.lease.leaseMs;
  }

  /** Fails the abandoned asset, which frees its bytes to be accepted again. Whoever fails it first wins; the others find the result. */
  private async reclaim(asset: Asset, scope: AssetScope, input: { name: string; bytes: Buffer }): Promise<Asset> {
    await this.repository.transition("processing", asset.failed({ code: "processing_failed", message: "Processing was interrupted" }));
    return this.accept(scope, input);
  }

  async resolveReadyAsset(scope: AssetScope, assetId: string): Promise<Asset> {
    const asset = await this.repository.get(scope, assetId);
    if (!asset) throw new AssetError("not_found", `Asset ${assetId} does not exist`);
    if (asset.state !== "ready") throw new AssetError("not_ready", `Asset ${assetId} is ${asset.state}${asset.record.failure ? `: ${asset.record.failure.message}` : ""}`);
    return asset;
  }

  /** A message submission binds its ready assets; this is the only way an asset gains a message id. `tx` binds in the transaction that accepts the message. */
  attach(scope: AssetScope, assetId: string, messageId: string, tx?: unknown): Promise<Asset> {
    return this.repository.on(tx).attach(scope, assetId, messageId);
  }

  /** Undoes `attach` for a message that was not delivered, so its assets can be sent again. */
  release(scope: AssetScope, assetId: string, messageId: string): Promise<void> {
    return this.repository.release(scope, assetId, messageId);
  }

  private async finish(asset: Asset, next: (asset: Asset) => Asset): Promise<Asset> {
    const moved = await this.repository.transition("processing", next(asset));
    if (!moved) throw new AssetError("conflict", `Asset ${asset.id} changed while it was processed`);
    return moved;
  }
}
