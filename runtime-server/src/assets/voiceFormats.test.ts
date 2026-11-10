import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalArtifactObjectStore } from "../creatorLearning/objectStore.js";
import { FfmpegAudioNormalizer } from "./adapters.js";
import type { Transcriber } from "./domain.js";
import { allow, harness, saying, scopeA } from "./kit.test.js";
import { AssetPipeline } from "./pipeline.js";
import { VoiceProcessor } from "./processors.js";
import { InMemoryAssetRepository } from "./repositories.js";
import { sniff } from "./sniff.js";

const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const PCM_BYTES_PER_SECOND = 32_000;

/** What each platform's voice message is, as ffmpeg can make it. Generated into a temp directory: no audio is committed. */
const FORMATS = [
  { name: "ogg opus", platforms: "Telegram, WhatsApp, Lark", mime: "audio/ogg", args: ["-c:a", "libopus", "-f", "ogg"] },
  { name: "m4a aac", platforms: "LINE, Instagram, Messenger, Slack", mime: "audio/mp4", args: ["-c:a", "aac", "-f", "ipod"] },
  { name: "caf opus", platforms: "iMessage", mime: "audio/x-caf", args: ["-c:a", "libopus", "-f", "caf"] },
  { name: "adts aac", platforms: "WhatsApp, Slack", mime: "audio/aac", args: ["-c:a", "aac", "-f", "adts"] },
  { name: "mp3", platforms: "WhatsApp, Slack", mime: "audio/mpeg", args: ["-c:a", "libmp3lame", "-f", "mp3"] },
  { name: "webm opus", platforms: "Slack", mime: "audio/webm", args: ["-c:a", "libopus", "-f", "webm"] },
  { name: "wav", platforms: "any", mime: "audio/wav", args: ["-c:a", "pcm_s16le", "-f", "wav"] },
];

/**
 * "Hello, this is a test." (1.75 s, 8 kHz) as AMR-NB 12.2 kbit/s, the format WeChat Customer Service returns.
 * This ffmpeg has no AMR encoder, so it was made once with opencore-amr (2.7 KB) and is kept inline.
 */
const AMR_NB = "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";

const pipelineFor = async (transcriber: Transcriber, seen: number[] = []) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voice-formats-"));
  const heard: Transcriber = { async transcribe(pcm) { seen.push(pcm.length / PCM_BYTES_PER_SECOND); return transcriber.transcribe(pcm); } };
  const pipeline = new AssetPipeline(new InMemoryAssetRepository(), new LocalArtifactObjectStore(path.join(directory, "blobs")), allow, [new VoiceProcessor(new FfmpegAudioNormalizer(), heard)]);
  return { pipeline, directory };
};

for (const format of FORMATS) {
  test(`a ${format.name} voice message (${format.platforms}) is audio, decoded by ffmpeg, and read as its transcript`, { skip: !hasFfmpeg && "ffmpeg is not installed" }, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "voice-source-"));
    const source = path.join(directory, "clip");
    try { execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "48000", ...format.args, source], { stdio: "pipe" }); }
    catch { await rm(directory, { recursive: true, force: true }); return t.skip(`this ffmpeg cannot encode ${format.name}`); }
    const seen: number[] = [];
    const { pipeline, directory: scratch } = await pipelineFor(saying("hello there"), seen);
    try {
      // The name says nothing: the content decides.
      const asset = await pipeline.accept(scopeA, { name: "voice", bytes: await readFile(source) });
      assert.equal(asset.record.kind, "audio");
      assert.equal(asset.record.mime, format.mime);
      assert.equal(asset.state, "ready", asset.record.failure?.message);
      assert.equal(asset.record.transcript, "hello there");
      assert.ok(seen[0]! > 0.8 && seen[0]! < 1.3, `decoded ${seen[0]} s of a 1 s clip`);
    } finally { await rm(directory, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true }); }
  });
}

test("an AMR voice message (WeChat Customer Service) is audio, decoded by ffmpeg, and read as its transcript", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  const seen: number[] = [];
  const { pipeline, directory } = await pipelineFor(saying("hello there"), seen);
  try {
    const bytes = Buffer.from(AMR_NB, "base64");
    assert.deepEqual(sniff(bytes, "voice"), { kind: "audio", mime: "audio/amr", ext: ".amr" });
    const asset = await pipeline.accept(scopeA, { name: "voice", bytes });
    assert.equal(asset.state, "ready", asset.record.failure?.message);
    assert.ok(seen[0]! > 1.5 && seen[0]! < 2, `decoded ${seen[0]} s of a 1.75 s clip`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a SILK voice message is recognized as audio but refused: ffmpeg has no SILK decoder", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  const { pipeline, directory } = await pipelineFor(saying("never reached"));
  try {
    // WeChat's own SILK starts with one 0x02 byte; the standard one starts with the signature.
    for (const head of [Buffer.concat([Buffer.from([2]), Buffer.from("#!SILK_V3")]), Buffer.from("#!SILK_V3")]) {
      const bytes = Buffer.concat([head, Buffer.alloc(200, 7)]);
      assert.equal(sniff(bytes, "voice").kind, "audio");
      const asset = await pipeline.accept(scopeA, { name: "voice", bytes });
      assert.deepEqual([asset.state, asset.record.failure], ["failed", { code: "malformed", message: "Audio could not be decoded" }]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a voice message that cannot be transcribed fails with one fixed message: the provider's words stay in the log", async () => {
  const log = console.error;
  const logged: string[] = [];
  console.error = (line: string) => { logged.push(String(line)); };
  try {
    const kit = await harness({ transcriber: { async transcribe() { return { status: "unavailable", reason: "Gemini quota exhausted for key AIzaSyEXAMPLE" }; } } });
    const asset = await kit.pipeline.accept(scopeA, { name: "voice.ogg", bytes: Buffer.concat([Buffer.from("OggS"), Buffer.alloc(40)]) });
    assert.deepEqual([asset.state, asset.record.failure?.code], ["failed", "unavailable"]);
    assert.doesNotMatch(asset.record.failure!.message, /Gemini|quota|AIza/);
    assert.ok(logged.some(line => line.includes("AIzaSyEXAMPLE")));
  } finally { console.error = log; }
});
