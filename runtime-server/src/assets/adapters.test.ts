import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { FfmpegAudioNormalizer, StreamingSttTranscriber, UnavailableTranscriber, transcriberFromEnvironment } from "./adapters.js";
import { AssetError } from "./domain.js";

const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("without a key the transcriber is unavailable and says why", async () => {
  const result = await transcriberFromEnvironment({}).transcribe(Buffer.alloc(10));
  assert.deepEqual(result, { status: "unavailable", reason: "DASHSCOPE_API_KEY is not set" });
  assert.equal((await transcriberFromEnvironment({ HATCH_FACTORY_STT_PROVIDER: "x" }).transcribe(Buffer.alloc(1))).status, "unavailable");
  assert.ok(transcriberFromEnvironment({ DASHSCOPE_API_KEY: "k" }) instanceof StreamingSttTranscriber);
  assert.ok(transcriberFromEnvironment({}) instanceof UnavailableTranscriber);
});

test("the streaming adapter joins committed sentences and reports a provider error", async () => {
  const ok = new StreamingSttTranscriber(cb => ({
    model: "fake", async start() {}, close() {},
    sendAudio(chunk) { if (chunk.length) setTimeout(() => { cb.onCommitted("one"); cb.onCommitted("two"); cb.onPartial("tail"); }, 0); }
  }), 150);
  assert.deepEqual(await ok.transcribe(Buffer.alloc(3200)), { status: "ok", text: "one two tail" });
  const broken = new StreamingSttTranscriber(() => ({ model: "fake", async start() { throw new Error("socket closed"); }, close() {}, sendAudio() {} }), 50);
  assert.deepEqual(await broken.transcribe(Buffer.alloc(3200)), { status: "unavailable", reason: "socket closed" });
});

test("ffmpeg turns a real WAV into 16 kHz mono PCM and rejects non-audio", { skip: !hasFfmpeg }, async () => {
  const wav = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-f", "wav", "pipe:1"], { maxBuffer: 10_000_000 });
  const normalizer = new FfmpegAudioNormalizer();
  const pcm = await normalizer.toPcm16k(wav, 300);
  assert.ok(Math.abs(pcm.length - 64_000) < 2_000);
  await assert.rejects(normalizer.toPcm16k(wav, 1), (e: unknown) => e instanceof AssetError && e.code === "too_large");
  await assert.rejects(normalizer.toPcm16k(Buffer.from("not audio at all"), 300), (e: unknown) => e instanceof AssetError && e.code === "malformed");
  await assert.rejects(new FfmpegAudioNormalizer("/nonexistent/ffmpeg").toPcm16k(wav, 300), (e: unknown) => e instanceof AssetError && e.code === "unavailable");
});
