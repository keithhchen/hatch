import { Asset, AssetError, type AssetBlobs, type AssetScope, type ContentModerator, type Moderated } from "../assets/domain.js";
import type { AssetPipeline } from "../assets/pipeline.js";
import type { AssetResolver, AssetUploader, UploadedAsset } from "./assets.js";
import { ConversationError, type ReadyAsset } from "./conversation.js";

/** Where the model reads files: the Product's shared input folder. */
export type ManualFiles = { writeManual(name: string, bytes: Buffer): Promise<void> };

const STATUS: Record<AssetError["code"], number> = {
  too_large: 413, unsupported_type: 415, unsafe_archive: 422, malformed: 422, moderation_blocked: 422, unavailable: 503, not_found: 404, not_ready: 409, conflict: 409
};

const CODE: Record<string, string> = { processing_failed: "asset_failed", not_ready: "asset_not_ready" };

const refusal = (code: string, message: string) => new ConversationError(STATUS[code as AssetError["code"]] ?? 422, CODE[code] ?? code, message);

/** The bytes the model gets for each kind: pixels, or extracted text. A voice message is its transcript and keeps no file. */
const DERIVATIVE = { image: "resized", file: "text" } as const;

const safeName = (name: string) => name.normalize("NFC").replace(/[\\/:\x00-\x1f]+/g, "-").replace(/^\.+/, "") || "file";

/** Distinct per asset, so two uploads with one name never share a path. */
const workspacePath = (asset: Asset): string =>
  asset.record.kind === "audio" ? "" : `input/manual/${asset.id.slice(0, 8)}-${safeName(asset.record.name)}${asset.record.kind === "file" ? ".md" : ""}`;

const ready = (asset: Asset): ReadyAsset => ({
  id: asset.id, kind: asset.record.kind, name: asset.record.name, mimeType: asset.record.mime, bytes: asset.record.bytes, sha256: asset.record.sha256,
  path: workspacePath(asset), ...(asset.record.transcript ? { transcript: asset.record.transcript } : {}), ...(asset.messageId ? { messageId: asset.messageId } : {})
});

/** Assets as conversations see them, over the upload pipeline: nothing is ready until the pipeline says so. */
export class PipelineAssets implements AssetResolver, AssetUploader {
  constructor(private pipeline: AssetPipeline, private blobs: AssetBlobs, private files: ManualFiles) {}

  async resolve(scope: AssetScope, assetId: string): Promise<ReadyAsset | undefined> {
    try { return ready(await this.pipeline.resolveReadyAsset(scope, assetId)); } catch (error) {
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
      await this.files.writeManual(path, await this.blobs.get(derivative.key));
    }
  }

  async attach(scope: AssetScope, assets: readonly ReadyAsset[], messageId: string): Promise<void> {
    for (const { id } of assets) await this.pipeline.attach(scope, id, messageId);
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

/** The moderator of a server that has none. Every upload fails with this, in the open: nothing is waved through unchecked. */
export class UnavailableModerator implements ContentModerator {
  async check(_content: Moderated): Promise<never> {
    throw new AssetError("unavailable", "Uploads are unavailable: no content moderator is configured on this server.");
  }
}
