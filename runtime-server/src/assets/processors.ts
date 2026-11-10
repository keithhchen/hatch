import sharp from "sharp";
import { convertUpload } from "../factoryAgents/markdownConverter.js";
import { AssetError, type AssetKind, type AudioNormalizer, type DerivativeRole, type Moderated, type Transcriber } from "./domain.js";
import { decodeText, type Sniffed } from "./sniff.js";

export type Output = { role: DerivativeRole; bytes: Buffer; mime: string; truncated?: boolean };
export type Processed = { outputs: Output[]; transcript?: string; moderate: Moderated };
export type ProcessorInput = { name: string; bytes: Buffer; sniffed: Sniffed };

/** One way of turning an original into what the model and the tools use. A new kind of asset is one class. */
export interface AssetProcessor {
  readonly kind: AssetKind;
  process(input: ProcessorInput): Promise<Processed>;
}

export const IMAGE_LONG_EDGE = 2000;
const MAX_PIXELS = 50_000_000;
const IMAGE_FORMAT: Record<string, { format: "jpeg" | "png" | "webp"; mime: string }> = {
  "image/jpeg": { format: "jpeg", mime: "image/jpeg" }, "image/png": { format: "png", mime: "image/png" },
  "image/webp": { format: "webp", mime: "image/webp" }, "image/gif": { format: "png", mime: "image/png" }
};

/** Applies EXIF orientation, then drops all metadata; the original stays untouched in storage. */
export class ImageProcessor implements AssetProcessor {
  readonly kind = "image";
  async process({ bytes, sniffed }: ProcessorInput): Promise<Processed> {
    const target = IMAGE_FORMAT[sniffed.mime]!;
    try {
      const resized = await sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error" })
        .rotate().resize({ width: IMAGE_LONG_EDGE, height: IMAGE_LONG_EDGE, fit: "inside", withoutEnlargement: true })
        .toFormat(target.format).toBuffer();
      return { outputs: [{ role: "resized", bytes: resized, mime: target.mime }], moderate: { type: "image", bytes: resized, mime: target.mime } };
    } catch (error) {
      throw new AssetError("malformed", `Unreadable image: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export const MAX_EXTRACTED_CHARS = 5_000_000;
type Convert = (name: string, bytes: Buffer) => Promise<{ bytes: Buffer }>;

/** Text formats are read directly; Office and PDF go through the shared Markdown converter. */
export class FileProcessor implements AssetProcessor {
  readonly kind = "file";
  constructor(private readonly convert: Convert = convertUpload) {}
  async process({ bytes, sniffed }: ProcessorInput): Promise<Processed> {
    const text = sniffed.mime === "application/pdf" || sniffed.mime.startsWith("application/vnd.") ? await this.convertDocument(bytes, sniffed) : decodeText(bytes);
    if (text === undefined) throw new AssetError("malformed", "File is not readable text");
    const truncated = text.length > MAX_EXTRACTED_CHARS;
    const kept = truncated ? text.slice(0, MAX_EXTRACTED_CHARS) : text;
    return { outputs: [{ role: "text", bytes: Buffer.from(kept), mime: "text/markdown", ...(truncated ? { truncated } : {}) }], moderate: { type: "text", text: kept } };
  }
  private async convertDocument(bytes: Buffer, sniffed: Sniffed): Promise<string> {
    try { return (await this.convert(`document${sniffed.ext}`, bytes)).bytes.toString("utf8"); }
    catch (error) {
      const missing = (error as { code?: string }).code === "ENOENT";
      throw new AssetError(missing ? "unavailable" : "malformed", missing ? "Document converter is not installed" : `Unreadable document: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export const MAX_VOICE_SECONDS = 300;

/** The transcript is the message text, so a voice message is ready only with a real one. */
export class VoiceProcessor implements AssetProcessor {
  readonly kind = "audio";
  constructor(private readonly normalizer: AudioNormalizer, private readonly transcriber: Transcriber) {}
  async process({ bytes }: ProcessorInput): Promise<Processed> {
    const pcm = await this.normalizer.toPcm16k(bytes, MAX_VOICE_SECONDS);
    const result = await this.transcriber.transcribe(pcm);
    if (result.status === "unavailable") {
      // The sender hears that it failed, never why: the provider's words stay in the log.
      console.error(JSON.stringify({ event: "transcription_unavailable", reason: result.reason }));
      throw new AssetError("unavailable", "Voice messages cannot be transcribed right now. Please send text instead.");
    }
    const text = result.text.trim();
    if (!text) throw new AssetError("malformed", "No speech was recognized in that voice message.");
    return { outputs: [{ role: "transcript", bytes: Buffer.from(text), mime: "text/plain" }], transcript: text, moderate: { type: "text", text } };
  }
}
