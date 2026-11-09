import type { PostgresQueryExecutor } from "../postgresStore.js";
import { FfmpegAudioNormalizer, transcriberFromEnvironment } from "../assets/adapters.js";
import type { AssetBlobs, ContentModerator } from "../assets/domain.js";
import { AttachmentFiles } from "../assets/files.js";
import { AssetPipeline } from "../assets/pipeline.js";
import { FileProcessor, ImageProcessor, VoiceProcessor } from "../assets/processors.js";
import { PostgresAssetRepository } from "../assets/repositories.js";
import { UnavailableModerator } from "../conversations/pipelineAssets.js";
import { ChatAssets } from "./assets.js";

/**
 * Chat's attachments in production: Postgres for records, object storage for bytes, ffmpeg and the configured recognizer
 * for voice. No moderation adapter exists yet, so unless one is passed every upload fails as unavailable, in the open.
 */
export async function openChatAssets(options: { pool: PostgresQueryExecutor; blobs: AssetBlobs; environment: NodeJS.ProcessEnv; moderator?: ContentModerator }): Promise<ChatAssets> {
  const repository = new PostgresAssetRepository(options.pool);
  await repository.initialize();
  const pipeline = new AssetPipeline(repository, options.blobs, options.moderator ?? new UnavailableModerator(),
    [new ImageProcessor(), new FileProcessor(), new VoiceProcessor(new FfmpegAudioNormalizer(), transcriberFromEnvironment(options.environment))]);
  return new ChatAssets({ pipeline, blobs: options.blobs, files: new AttachmentFiles(repository, options.blobs) });
}
