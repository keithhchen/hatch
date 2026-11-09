import type { Pool } from "pg";
import { FfmpegAudioNormalizer, transcriberFromEnvironment } from "../assets/adapters.js";
import type { AssetBlobs, ContentModerator } from "../assets/domain.js";
import { AssetPipeline } from "../assets/pipeline.js";
import { FileProcessor, ImageProcessor, VoiceProcessor } from "../assets/processors.js";
import { PostgresAssetRepository } from "../assets/repositories.js";
import { PipelineAssets, UnavailableModerator } from "./pipelineAssets.js";
import type { StudioDeps } from "./studio.js";

/**
 * Studio's attachments in production: Postgres for records, object storage for bytes, ffmpeg and the configured
 * recognizer for voice. No moderation adapter exists yet, so unless one is passed every upload fails as unavailable.
 */
export async function openProductAssets(pool: Pool, blobs: AssetBlobs, environment: NodeJS.ProcessEnv, moderator: ContentModerator = new UnavailableModerator()): Promise<NonNullable<StudioDeps["assets"]>> {
  const repository = new PostgresAssetRepository(pool);
  await repository.initialize();
  const pipeline = new AssetPipeline(repository, blobs, moderator, [new ImageProcessor(), new FileProcessor(), new VoiceProcessor(new FfmpegAudioNormalizer(), transcriberFromEnvironment(environment))]);
  return files => new PipelineAssets(pipeline, blobs, files);
}
