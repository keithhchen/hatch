export type TtsSynthesizer = {
  synthesize(input: {
    creatorId: string;
    agentId: string;
    text: string;
    previousRequestIds: string[];
  }): Promise<{ audio: Uint8Array; requestId: string }>;
};

export type VoiceStatus = {
  enabled: boolean;
  label: string | null;
};

/**
 * The Runtime relays consumer TTS to the Registry, which owns the Creator
 * voice asset and the ElevenLabs credential. Runtime never sees a provider
 * key; it only checks the signed-in entitlement before asking.
 */
export class RegistryTtsSynthesizer implements TtsSynthesizer {
  constructor(private readonly options: {
    registryUrl: string;
    serviceToken: string;
    timeoutMs?: number;
  }) {}

  async synthesize(input: {
    creatorId: string;
    agentId: string;
    text: string;
    previousRequestIds: string[];
  }): Promise<{ audio: Uint8Array; requestId: string }> {
    const base = this.options.registryUrl.replace(/\/$/, "");
    const response = await fetch(`${base}/v1/tts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.serviceToken}`,
        "content-type": "application/json",
        accept: "audio/mpeg"
      },
      body: JSON.stringify({
        creator_id: input.creatorId,
        agent_id: input.agentId,
        text: input.text,
        previous_request_ids: input.previousRequestIds
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000)
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Text-to-speech failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    return { audio, requestId: response.headers.get("x-request-id") ?? "" };
  }
}

/** One catalog fetch gives the Runtime the per-Creator voice status. */
export class RegistryVoiceStatusResolver {
  constructor(private readonly options: { registryUrl: string; serviceToken: string; timeoutMs?: number }) {}

  async byCreator(): Promise<Map<string, VoiceStatus>> {
    const base = this.options.registryUrl.replace(/\/$/, "");
    const response = await fetch(`${base}/v1/catalog/agents`, {
      headers: {
        authorization: `Bearer ${this.options.serviceToken}`,
        accept: "application/json"
      },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000)
    });
    if (!response.ok) throw new Error(`Registry catalog fetch failed with HTTP ${response.status}`);
    const entries = (await response.json()) as Array<{ creator_id?: unknown; voice?: unknown }>;
    const byCreator = new Map<string, VoiceStatus>();
    for (const entry of entries ?? []) {
      const creatorId = typeof entry.creator_id === "string" ? entry.creator_id : "";
      if (!creatorId || typeof entry.voice !== "object" || entry.voice === null) continue;
      const voice = entry.voice as Record<string, unknown>;
      byCreator.set(creatorId, {
        enabled: voice.enabled === true,
        label: typeof voice.label === "string" ? voice.label : null
      });
    }
    return byCreator;
  }
}

export function registryTtsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): RegistryTtsSynthesizer | undefined {
  const registryUrl = environment.HATCH_REGISTRY_URL?.trim();
  const serviceToken = environment.HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN?.trim();
  if (!registryUrl && !serviceToken) return undefined;
  if (!registryUrl || !serviceToken) {
    throw new Error("HATCH_REGISTRY_URL and HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN must be configured together for TTS");
  }
  return new RegistryTtsSynthesizer({ registryUrl, serviceToken });
}
