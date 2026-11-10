import { UpstreamError } from "../errors/upstream.js";
import type { Transcriber, Transcript } from "./domain.js";

export const GEMINI_TRANSCRIBE_MODEL = "gemini-3.5-transcribe";

/** The 44-byte RIFF header that makes 16 kHz mono 16-bit PCM an audio file Gemini accepts. */
function wavOf(pcm16k: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm16k.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm16k.length, 40);
  return Buffer.concat([header, pcm16k]);
}

/**
 * Gemini 3.5 Transcribe over the Interactions API: one request, the whole clip inline, a verbatim transcript back.
 * The model detects the language itself, so zh, en, ja and a mix of them need no hint. `store: false` keeps the
 * recording out of Google's interaction history. A failed call is an UpstreamError.
 */
export class GeminiTranscriber implements Transcriber {
  constructor(
    private readonly apiKey: string,
    private readonly model = GEMINI_TRANSCRIBE_MODEL,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 60_000
  ) {}

  async transcribe(pcm16k: Buffer): Promise<Transcript> {
    try {
      const response = await this.fetchImpl("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({ model: `models/${this.model}`, store: false, input: [{ type: "audio", data: wavOf(pcm16k).toString("base64"), mime_type: "audio/wav" }] }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) throw new Error(`Gemini transcription failed: HTTP ${response.status} ${await response.text()}`);
      const body = await response.json() as { steps?: Array<{ type?: string; content?: Array<{ text?: string }> }> };
      const text = (body.steps ?? []).filter(step => step.type === "model_output").flatMap(step => step.content ?? []).map(part => part.text ?? "").join("").trim();
      return { status: "ok", text };
    } catch (error) { throw UpstreamError.of(error); }
  }
}
