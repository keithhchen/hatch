import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { UpstreamError } from "../errors/upstream.js";
import { FfmpegAudioNormalizer, FirstAvailableTranscriber, StreamingSttTranscriber, UnavailableTranscriber, transcriberFromEnvironment } from "./adapters.js";
import { AssetError, type Transcriber, type Transcript } from "./domain.js";
import { GeminiTranscriber } from "./geminiTranscriber.js";

const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("without a key the transcriber is unavailable and says why", async () => {
  const result = await transcriberFromEnvironment({}).transcribe(Buffer.alloc(10));
  assert.deepEqual(result, { status: "unavailable", reason: "GEMINI_API_KEY or DASHSCOPE_API_KEY is not set" });
  assert.equal((await transcriberFromEnvironment({ HATCH_TRANSCRIBE_PROVIDERS: "x" }).transcribe(Buffer.alloc(1))).status, "unavailable");
  assert.ok(transcriberFromEnvironment({}) instanceof UnavailableTranscriber);
});

test("the default chain is Gemini then Qwen, each only when its key is set", () => {
  assert.ok(transcriberFromEnvironment({ GEMINI_API_KEY: "k" }) instanceof GeminiTranscriber);
  assert.ok(transcriberFromEnvironment({ DASHSCOPE_API_KEY: "k" }) instanceof StreamingSttTranscriber);
  assert.ok(transcriberFromEnvironment({ GEMINI_API_KEY: "k", DASHSCOPE_API_KEY: "k" }) instanceof FirstAvailableTranscriber);
  assert.ok(transcriberFromEnvironment({ HATCH_TRANSCRIBE_PROVIDERS: "qwen", GEMINI_API_KEY: "k", DASHSCOPE_API_KEY: "k" }) instanceof StreamingSttTranscriber);
});

const stub = (outcome: Transcript | Error): Transcriber & { calls: number } => ({
  calls: 0,
  async transcribe() { this.calls++; if (outcome instanceof Error) throw outcome; return outcome; }
});
const quiet = async (work: () => Promise<void>) => { const log = console.error; console.error = () => undefined; try { await work(); } finally { console.error = log; } };

test("the chain stops at the first transcript and falls over an unavailable or upstream-failed one", async () => {
  const first = stub({ status: "ok", text: "one" }), second = stub({ status: "ok", text: "two" });
  assert.deepEqual(await new FirstAvailableTranscriber([first, second]).transcribe(Buffer.alloc(1)), { status: "ok", text: "one" });
  assert.equal(second.calls, 0);
  await quiet(async () => {
    const down = stub({ status: "unavailable", reason: "socket closed" }), broken = stub(UpstreamError.of(new Error("Gemini: HTTP 503")));
    assert.deepEqual(await new FirstAvailableTranscriber([down, broken, second]).transcribe(Buffer.alloc(1)), { status: "ok", text: "two" });
  });
});

test("when every transcriber fails the chain throws the upstream failure, and Hatch's own errors pass straight through", async () => {
  await quiet(async () => {
    const upstream = UpstreamError.of(new Error("Gemini: HTTP 503"));
    await assert.rejects(new FirstAvailableTranscriber([stub(upstream), stub({ status: "unavailable", reason: "x" })]).transcribe(Buffer.alloc(1)), upstream);
    assert.deepEqual(await new FirstAvailableTranscriber([stub({ status: "unavailable", reason: "x" })]).transcribe(Buffer.alloc(1)), { status: "unavailable", reason: "x" });
    const own = stub(new Error("bug")), after = stub({ status: "ok", text: "never" });
    await assert.rejects(new FirstAvailableTranscriber([own, after]).transcribe(Buffer.alloc(1)), /bug/);
    assert.equal(after.calls, 0);
  });
});

test("Gemini gets the clip as an inline WAV, unstored, and returns the model's text", async () => {
  let sent: { url: string; headers: Record<string, string>; body: any } | undefined;
  const gemini = new GeminiTranscriber("key", "gemini-3.5-transcribe", async (url, init) => {
    sent = { url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) };
    return Response.json({ steps: [{ type: "model_output", content: [{ type: "text", text: "你好，hello。 " }] }] });
  });
  assert.deepEqual(await gemini.transcribe(Buffer.alloc(3200)), { status: "ok", text: "你好，hello。" });
  assert.equal(sent!.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(sent!.headers["x-goog-api-key"], "key");
  assert.equal(sent!.body.model, "models/gemini-3.5-transcribe");
  assert.equal(sent!.body.store, false);
  const [audio] = sent!.body.input;
  assert.equal(audio.mime_type, "audio/wav");
  const wav = Buffer.from(audio.data, "base64");
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.length, 44 + 3200);
});

test("a Gemini HTTP error or network failure is an UpstreamError that keeps the provider's words server-side", async () => {
  const rejected = new GeminiTranscriber("key", undefined, async () => new Response("quota exhausted", { status: 429 }));
  await assert.rejects(rejected.transcribe(Buffer.alloc(1)), (e: unknown) => e instanceof UpstreamError && e.kind === "quota" && e.status === 429 && e.provider === "google");
  const offline = new GeminiTranscriber("key", undefined, async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(offline.transcribe(Buffer.alloc(1)), (e: unknown) => e instanceof UpstreamError && e.kind === "transient");
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
