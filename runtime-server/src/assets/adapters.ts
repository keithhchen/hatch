import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ElevenLabsStreamingStt, QwenStreamingStt, type StreamingSttCallbacks, type StreamingSttProvider } from "../factoryAgents/stt.js";
import { UpstreamError } from "../errors/upstream.js";
import { GeminiTranscriber } from "./geminiTranscriber.js";
import { AssetError, type AudioNormalizer, type Transcriber, type Transcript } from "./domain.js";

const run = promisify(execFile);
const PCM_BYTES_PER_SECOND = 32_000;

/** Decodes anything ffmpeg reads into 16 kHz mono PCM, refusing audio longer than the limit. */
export class FfmpegAudioNormalizer implements AudioNormalizer {
  constructor(private readonly binary = process.env.FFMPEG_BIN || "ffmpeg") {}
  async toPcm16k(audio: Buffer, maxSeconds: number): Promise<Buffer> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-audio-"));
    const source = path.join(directory, "input");
    try {
      await writeFile(source, audio);
      const { stdout } = await run(this.binary, ["-v", "error", "-nostdin", "-protocol_whitelist", "file", "-i", source, "-t", String(maxSeconds + 1), "-vn", "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"],
        { encoding: "buffer", timeout: 60_000, maxBuffer: (maxSeconds + 2) * PCM_BYTES_PER_SECOND });
      if (stdout.length > maxSeconds * PCM_BYTES_PER_SECOND) throw new AssetError("too_large", `Voice message is longer than ${maxSeconds} seconds`);
      return stdout;
    } catch (error) {
      if (error instanceof AssetError) throw error;
      if ((error as { code?: string }).code === "ENOENT") throw new AssetError("unavailable", "ffmpeg is not installed");
      throw new AssetError("malformed", "Audio could not be decoded");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

/** The stand-in when no provider is configured. It says so; it never invents text. */
export class UnavailableTranscriber implements Transcriber {
  constructor(private readonly reason: string) {}
  async transcribe(): Promise<Transcript> { return { status: "unavailable", reason: this.reason }; }
}

type SttFactory = (callbacks: StreamingSttCallbacks) => StreamingSttProvider;

/** Adapts the repo's streaming recognizer (Qwen or ElevenLabs): feed all audio, then wait for the stream to go quiet. */
export class StreamingSttTranscriber implements Transcriber {
  constructor(private readonly create: SttFactory, private readonly quietMs = 4_000, private readonly maxMs = 120_000) {}
  async transcribe(pcm16k: Buffer): Promise<Transcript> {
    const sentences: string[] = [];
    let partial = "";
    let failure: unknown;
    let touched = Date.now();
    const provider = this.create({
      onPartial: text => { partial = text; touched = Date.now(); },
      onCommitted: text => { sentences.push(text); partial = ""; touched = Date.now(); },
      onError: error => { failure = error; }
    });
    try {
      await provider.start();
      for (let at = 0; at < pcm16k.length; at += 3200) provider.sendAudio(pcm16k.subarray(at, at + 3200));
      const deadline = Date.now() + this.maxMs;
      touched = Date.now();
      while (!failure && Date.now() - touched < this.quietMs && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      failure = error;
    } finally { provider.close(); }
    if (failure) return { status: "unavailable", reason: failure instanceof Error ? failure.message : String(failure) };
    return { status: "ok", text: [...sentences, partial].filter(Boolean).join(" ") };
  }
}

/** Tries each transcriber in order; one that is unavailable or fails upstream hands over to the next. When none succeeds, an upstream failure is thrown, else the last result stands. */
export class FirstAvailableTranscriber implements Transcriber {
  constructor(private readonly chain: Transcriber[]) {}
  async transcribe(pcm16k: Buffer): Promise<Transcript> {
    let last: Transcript = { status: "unavailable", reason: "No transcriber is configured" };
    let upstream: UpstreamError | undefined;
    for (const transcriber of this.chain) {
      try {
        last = await transcriber.transcribe(pcm16k);
        if (last.status === "ok") return last;
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        upstream ??= error;
      }
      console.error(JSON.stringify({ event: "transcriber_fallback", transcriber: transcriber.constructor.name, ...(upstream ? { provider: upstream.provider, status: upstream.status } : {}) }));
    }
    if (upstream) throw upstream;
    return last;
  }
}

const streaming = (recognizer: new (options: StreamingSttCallbacks & { environment: NodeJS.ProcessEnv }) => StreamingSttProvider, environment: NodeJS.ProcessEnv): Transcriber =>
  new StreamingSttTranscriber(callbacks => new recognizer({ ...callbacks, environment }));

const PROVIDERS: Record<string, { key: string; create(environment: NodeJS.ProcessEnv): Transcriber }> = {
  gemini: { key: "GEMINI_API_KEY", create: environment => new GeminiTranscriber(environment.GEMINI_API_KEY!.trim(), environment.HATCH_GEMINI_STT_MODEL?.trim() || undefined) },
  qwen: { key: "DASHSCOPE_API_KEY", create: environment => streaming(QwenStreamingStt, environment) },
  elevenlabs: { key: "ELEVENLABS_API_KEY", create: environment => streaming(ElevenLabsStreamingStt, environment) }
};

/** HATCH_TRANSCRIBE_PROVIDERS is a comma-separated chain, default `gemini,qwen`; a provider without its API key is left out. (HATCH_FACTORY_STT_PROVIDER stays the live Factory recognizer's.) */
export function transcriberFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Transcriber {
  const names = (environment.HATCH_TRANSCRIBE_PROVIDERS?.trim() || "gemini,qwen").toLowerCase().split(",").map(name => name.trim()).filter(Boolean);
  const unsupported = names.find(name => !PROVIDERS[name]);
  if (unsupported) return new UnavailableTranscriber(`Unsupported STT provider: ${unsupported}`);
  const configured = names.map(name => PROVIDERS[name]!).filter(provider => environment[provider.key]?.trim());
  if (!configured.length) return new UnavailableTranscriber(`${names.map(name => PROVIDERS[name]!.key).join(" or ")} is not set`);
  const chain = configured.map(provider => provider.create(environment));
  return chain.length === 1 ? chain[0]! : new FirstAvailableTranscriber(chain);
}
