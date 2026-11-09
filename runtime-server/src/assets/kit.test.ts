// Test fixtures only. Nothing here is imported by product code.
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { zipSync } from "fflate";
import { LocalArtifactObjectStore } from "../creatorLearning/objectStore.js";
import type { AssetScope, AudioNormalizer, ContentModerator, Transcriber } from "./domain.js";
import { AssetPipeline } from "./pipeline.js";
import { FileProcessor, ImageProcessor, VoiceProcessor } from "./processors.js";
import { InMemoryAssetRepository } from "./repositories.js";

export const scopeA: AssetScope = { kind: "account", accountId: "acct-1", conversationId: "conv-1" };
export const scopeB: AssetScope = { kind: "account", accountId: "acct-2", conversationId: "conv-1" };
export const contact = (connectionId: string, contactId: string, conversationId = "conv-1"): AssetScope => ({ kind: "contact", connectionId, contactId, conversationId });

export const png = (width = 10, height = 10) => sharp({ create: { width, height, channels: 3, background: "#3366ff" } }).png().toBuffer();
export const wav = () => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(32)]);
export const docx = () => Buffer.from(zipSync({ "[Content_Types].xml": new Uint8Array([60]), "word/document.xml": new Uint8Array([60]) }));

export const allow: ContentModerator = { async check() { return { allowed: true }; } };
export const block = (reason = "blocked"): ContentModerator => ({ async check() { return { allowed: false, reason }; } });
export const pcmNormalizer: AudioNormalizer = { async toPcm16k() { return Buffer.alloc(3200); } };
export const saying = (text: string): Transcriber => ({ async transcribe() { return { status: "ok", text }; } });

export async function harness(options: { moderator?: ContentModerator; transcriber?: Transcriber; convert?: ConstructorParameters<typeof FileProcessor>[0] } = {}) {
  const blobs = new LocalArtifactObjectStore(await mkdtemp(path.join(os.tmpdir(), "assets-test-")));
  const repository = new InMemoryAssetRepository();
  const pipeline = new AssetPipeline(repository, blobs, options.moderator ?? allow, [
    new ImageProcessor(),
    new FileProcessor(options.convert ?? (async (_name, bytes) => ({ bytes: Buffer.from(`# converted ${bytes.length}`) }))),
    new VoiceProcessor(pcmNormalizer, options.transcriber ?? saying("hello there"))
  ]);
  return { blobs, repository, pipeline };
}
