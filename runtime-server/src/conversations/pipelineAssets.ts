import { Asset, AssetError, type AssetBlobs, type AssetScope, type ContentModerator, type Moderated } from "../assets/domain.js";
import type { AssetPipeline } from "../assets/pipeline.js";
import type { AssetResolver, AssetUploader, UploadedAsset, Workshop } from "./assets.js";
import { ConversationError, type ReadyAsset } from "./conversation.js";

const STATUS: Record<AssetError["code"], number> = {
  too_large: 413, unsupported_type: 415, unsafe_archive: 422, malformed: 422, moderation_blocked: 422, unavailable: 503, not_found: 404, not_ready: 409, conflict: 409
};

const CODE: Record<string, string> = { processing_failed: "asset_failed", not_ready: "asset_not_ready", conflict: "asset_conflict" };

const refusal = (code: string, message: string) => new ConversationError(STATUS[code as AssetError["code"]] ?? 422, CODE[code] ?? code, message);

/** The bytes the model gets for each kind: pixels, or extracted text. A voice message is its transcript and keeps no file. */
const DERIVATIVE = { image: "resized", file: "text" } as const;

const safeName = (name: string) => name.normalize("NFC").replace(/[\\/:\x00-\x1f]+/g, "-").replace(/^\.+/, "") || "file";

/** A Product's workers read uploads in its shared input folder. Distinct per asset, so two uploads with one name never share a path. */
export const productPlacement = (asset: Asset): string =>
  asset.record.kind === "audio" ? "" : `input/manual/${asset.id.slice(0, 8)}-${safeName(asset.record.name)}${asset.record.kind === "file" ? ".md" : ""}`;

const ready = (asset: Asset, place: Workshop["place"]): ReadyAsset => ({
  id: asset.id, kind: asset.record.kind, name: asset.record.name, mimeType: asset.record.mime, bytes: asset.record.bytes, sha256: asset.record.sha256,
  path: place(asset), ...(asset.record.transcript ? { transcript: asset.record.transcript } : {})
});

/** Assets as conversations see them, over the upload pipeline: nothing is ready until the pipeline says so. */
export class PipelineAssets implements AssetResolver, AssetUploader {
  constructor(private pipeline: AssetPipeline, private blobs: AssetBlobs, private workshop: Workshop) {}

  async resolve(scope: AssetScope, assetId: string): Promise<ReadyAsset | undefined> {
    try { return ready(await this.pipeline.resolveReadyAsset(scope, assetId), this.workshop.place); } catch (error) {
      if (!(error instanceof AssetError)) throw error;
      if (error.code === "not_found") return undefined;
      throw refusal(error.code, error.message);
    }
  }

  async stage(scope: AssetScope, assets: readonly ReadyAsset[]): Promise<void> {
    for (const { id, kind, path } of assets) {
      if (kind === "audio") continue;
      const derivative = (await this.pipeline.resolveReadyAsset(scope, id)).derivative(DERIVATIVE[kind]);
      if (!derivative) throw new ConversationError(500, "asset_incomplete", `Asset ${id} has no ${DERIVATIVE[kind]} form.`);
      await this.workshop.files.writeManual(path, await this.blobs.get(derivative.key));
    }
  }

  async attach(scope: AssetScope, assets: readonly ReadyAsset[], messageId: string): Promise<void> {
    const bound: ReadyAsset[] = [];
    try {
      for (const asset of assets) { await this.pipeline.attach(scope, asset.id, messageId); bound.push(asset); }
    } catch (error) {
      await this.release(scope, bound, messageId);
      throw error instanceof AssetError ? refusal(error.code, error.message) : error;
    }
  }

  async release(scope: AssetScope, assets: readonly ReadyAsset[], messageId: string): Promise<void> {
    for (const { id } of assets) await this.pipeline.release(scope, id, messageId);
  }

  async upload(scope: AssetScope, input: { name: string; bytes: Buffer }): Promise<UploadedAsset> {
    try {
      const asset = await this.pipeline.accept(scope, input);
      if (asset.state === "failed") throw refusal(asset.record.failure!.code, asset.record.failure!.message);
      return { asset_id: asset.id, kind: asset.record.kind, name: asset.record.name, bytes: asset.record.bytes, state: asset.state === "ready" ? "ready" : "processing" };
    } catch (error) {
      throw error instanceof AssetError ? refusal(error.code, error.message) : error;
    }
  }
}

/** The moderator of a server where content moderation is off: every upload is allowed. Aliyun Green replaces it when the output guard turns moderation on. */
export class NoModeration implements ContentModerator {
  async check(_content: Moderated): Promise<{ allowed: true }> {
    return { allowed: true };
  }
}
