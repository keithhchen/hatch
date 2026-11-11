import { AssetError } from "./domain.js";
import { MAX_BYTES } from "./pipeline.js";
import type { AssetProcessor } from "./processors.js";

/** Speech to text for a composer: what a voice message goes through, without becoming an asset. */
export class Dictation {
  constructor(private readonly voice: AssetProcessor) {}

  async text(audio: Buffer): Promise<string> {
    if (audio.length > MAX_BYTES.audio) throw new AssetError("too_large", `audio exceeds ${MAX_BYTES.audio} bytes`);
    const { transcript } = await this.voice.process({ name: "dictation", bytes: audio, sniffed: { kind: "audio", mime: "audio/*", ext: "" } });
    return transcript ?? "";
  }
}
