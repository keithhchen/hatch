import { createHash, randomUUID } from "node:crypto";

export type VoiceAsset = {
  voice_id: string;
  creator_id: string;
  provider: string;
  provider_voice_id: string;
  sample: {
    sha256: string;
    duration_s: number | null;
    format: string;
    size_bytes: number;
  };
  consent: {
    version: string;
    accepted_at: string;
  };
  status: "active" | "revoked";
  created_at: string;
  revoked_at: string | null;
};

export type VoiceStatus = {
  enabled: boolean;
  label: string | null;
};

export type TtsUsageRecord = {
  request_id: string;
  creator_id: string;
  agent_id: string;
  chars: number;
  provider_credits: number;
  at: string;
};

export type VoiceProvider = {
  createVoice(input: { name: string; files: Uint8Array[] }): Promise<string>;
  synthesize(input: {
    providerVoiceId: string;
    text: string;
    previousRequestIds: string[];
  }): Promise<{ audio: Uint8Array; requestId: string }>;
  deleteVoice(providerVoiceId: string): Promise<void>;
};

const VOICE_NAME_PREFIX = "hatch-creator-";
const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

export class VoiceProviderUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceProviderUnavailable";
  }
}

export class UnavailableVoiceProvider implements VoiceProvider {
  createVoice(): Promise<string> {
    throw new VoiceProviderUnavailable("ElevenLabs voice cloning is not configured.");
  }

  synthesize(): Promise<{ audio: Uint8Array; requestId: string }> {
    throw new VoiceProviderUnavailable("ElevenLabs text-to-speech is not configured.");
  }

  deleteVoice(): Promise<void> {
    throw new VoiceProviderUnavailable("ElevenLabs voice cloning is not configured.");
  }
}

export class ElevenLabsVoiceProvider implements VoiceProvider {
  private readonly apiKey: string;
  private readonly apiBase: string;

  constructor(options: { apiKey: string; apiBase?: string }) {
    this.apiKey = options.apiKey.trim();
    this.apiBase = (options.apiBase ?? ELEVENLABS_API).replace(/\/$/, "");
    if (!this.apiKey) throw new Error("ElevenLabs API key cannot be blank");
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): VoiceProvider {
    const apiKey = environment.HATCH_ELEVENLABS_API_KEY?.trim() ?? "";
    if (!apiKey) return new UnavailableVoiceProvider();
    return new ElevenLabsVoiceProvider({
      apiKey,
      apiBase: environment.HATCH_ELEVENLABS_API_BASE?.trim() || undefined,
    });
  }

  async createVoice(input: { name: string; files: Uint8Array[] }): Promise<string> {
    const boundary = `----hatch-${randomUUID().replaceAll("-", "")}`;
    const parts: Buffer[] = [];
    for (const file of input.files) {
      parts.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
      parts.push(Buffer.from(`Content-Disposition: form-data; name="files"; filename="voice-sample.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`, "utf8"));
      parts.push(Buffer.from(file));
      parts.push(Buffer.from("\r\n", "utf8"));
    }
    parts.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="name"\r\n\r\n${VOICE_NAME_PREFIX}${input.name}\r\n`, "utf8"));
    parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
    const body = Buffer.concat(parts);

    const response = await fetch(`${this.apiBase}/voices/add`, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    const payload = await parseJson(response, "ElevenLabs create voice");
    if (!response.ok) throw new VoiceProviderUnavailable(`ElevenLabs create voice failed: ${String(payload.detail ?? payload.message ?? response.status)}`);
    const voiceId = String(payload.voice_id ?? "");
    if (!voiceId) throw new VoiceProviderUnavailable("ElevenLabs create voice returned no voice_id");
    return voiceId;
  }

  async synthesize(input: {
    providerVoiceId: string;
    text: string;
    previousRequestIds: string[];
  }): Promise<{ audio: Uint8Array; requestId: string }> {
    const response = await fetch(`${this.apiBase}/text-to-speech/${encodeURIComponent(input.providerVoiceId)}`, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: input.text,
        model_id: "eleven_multilingual_v2",
        ...(input.previousRequestIds.length > 0
          ? { previous_request_ids: input.previousRequestIds.slice(0, 3) }
          : {}),
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new VoiceProviderUnavailable(`ElevenLabs text-to-speech failed: ${String((payload as Record<string, unknown>)?.detail ?? payload?.message ?? response.status)}`);
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength === 0) throw new VoiceProviderUnavailable("ElevenLabs text-to-speech returned empty audio");
    return { audio, requestId: response.headers.get("x-request-id") ?? `req_${randomUUID().replaceAll("-", "")}` };
  }

  async deleteVoice(providerVoiceId: string): Promise<void> {
    const response = await fetch(`${this.apiBase}/voices/${encodeURIComponent(providerVoiceId)}`, {
      method: "DELETE",
      headers: { "xi-api-key": this.apiKey },
    });
    if (!response.ok && response.status !== 404) {
      throw new VoiceProviderUnavailable(`ElevenLabs delete voice failed: ${response.status}`);
    }
  }
}

export function hashSample(data: Uint8Array): string {
  return `sha256:${createHash("sha256").update(Buffer.from(data)).digest("hex")}`;
}

export function voiceLabel(creatorName: string): string {
  return `${creatorName} 的声音`;
}

async function parseJson(response: Response, operation: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("unexpected payload");
    return parsed as Record<string, unknown>;
  } catch {
    throw new VoiceProviderUnavailable(`${operation} returned an unreadable response`);
  }
}
