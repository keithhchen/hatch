import type { Agent, AgentOptions, StreamFn } from "@earendil-works/pi-agent-core";
import type { Models, Model } from "@earendil-works/pi-ai";
import type { LlmProfile } from "../llmProfiles.js";
import { llmProfile } from "../llmProfiles.js";
import { OpenAICompatibleAdapter } from "./openAiCompatible.js";
import type { AdapterOptions, AgentAdapterOptions, Endpoint } from "./adapter.js";
import { agentFor, agentOptionsFor, modelFor, modelsFor, streamFnFor } from "./assemble.js";

export const KIMI_MODEL = "kimi-k2.6" as const;
export const KIMI_DEFAULT_BASE_URL = "https://api.moonshot.cn/v1";

const KIMI_PROVIDER_CN = "moonshotai-cn" as const;
const KIMI_PROVIDER_GLOBAL = "moonshotai" as const;
const KIMI_HOSTS = new Set(["api.moonshot.cn", "api.moonshot.ai"]);

export type KimiProvider = typeof KIMI_PROVIDER_CN | typeof KIMI_PROVIDER_GLOBAL;
export type KimiModel = Model<"openai-completions">;
export type KimiAdapterOptions = AdapterOptions;
export type KimiAgentOptions = AgentAdapterOptions;

/** Normalize and validate an official Moonshot OpenAI-compatible endpoint. */
export function normalizeKimiBaseUrl(value = KIMI_DEFAULT_BASE_URL): string {
  const raw = value.trim();
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("Kimi base URL must be an absolute official Moonshot API URL");
  }

  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
  const officialMoonshot = endpoint.protocol === "https:" && KIMI_HOSTS.has(hostname) && !endpoint.port;
  const localTestDouble = endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(hostname);
  if (
    (!officialMoonshot && !localTestDouble) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("Kimi base URL must use an official Moonshot HTTPS endpoint");
  }

  const pathname = endpoint.pathname.replace(/\/+$/, "") || "/v1";
  endpoint.pathname = pathname;
  return endpoint.toString().replace(/\/$/, "");
}

/**
 * Moonshot rejects an assistant tool-call message whose content is null or empty, although
 * that shape is valid in the OpenAI Chat Completions schema. Keep Pi's canonical
 * tool-call/result history and apply only Moonshot's documented provider-boundary rule:
 * omit the empty content field.
 */
export function omitEmptyToolCallContent(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const body = payload as { messages?: unknown };
  if (!Array.isArray(body.messages)) return payload;
  return {
    ...body,
    messages: body.messages.flatMap((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return [message];
      const candidate = message as { role?: unknown; content?: unknown; tool_calls?: unknown };
      if (candidate.role !== "assistant") return [message];
      if (Array.isArray(candidate.tool_calls) && candidate.tool_calls.length > 0
        && (typeof candidate.content !== "string" || candidate.content.trim().length === 0)) {
        const normalized = { ...candidate } as Record<string, unknown>;
        delete normalized.content;
        return [normalized];
      }
      return [message];
    })
  };
}

/** The whole Moonshot Kimi family (k2.6, k3.1, with or without thinking). */
export class KimiAdapter extends OpenAICompatibleAdapter {
  override endpoint(profile: LlmProfile, options: AdapterOptions): Endpoint {
    const env = options.env ?? process.env;
    const fromEnv = profile.endpointEnv ? env[profile.endpointEnv] : undefined;
    const baseUrl = normalizeKimiBaseUrl(options.baseUrl ?? options.baseURL ?? fromEnv ?? profile.baseUrl);
    return { baseUrl, provider: new URL(baseUrl).hostname === "api.moonshot.ai" ? KIMI_PROVIDER_GLOBAL : KIMI_PROVIDER_CN };
  }

  override normalizePayload(profile: LlmProfile, payload: unknown): unknown {
    return super.normalizePayload(profile, omitEmptyToolCallContent(payload));
  }
}

// Direct Kimi K2.6 entry points for callers that bypass profile selection.
const adapter = new KimiAdapter();
const kimiK26 = (): LlmProfile => llmProfile(KIMI_MODEL);

export function createKimiModel(options: Pick<KimiAdapterOptions, "baseUrl" | "baseURL" | "env"> = {}): KimiModel {
  return modelFor(adapter, kimiK26(), options) as KimiModel;
}

export function createKimiStreamFn(options: KimiAdapterOptions = {}): StreamFn {
  return streamFnFor(adapter, kimiK26(), options);
}

export function createKimiModels(options: KimiAdapterOptions = {}): { models: Models; model: KimiModel } {
  return modelsFor(adapter, kimiK26(), options) as { models: Models; model: KimiModel };
}

export function createKimiAgentOptions(options: KimiAgentOptions = {}): AgentOptions {
  return agentOptionsFor(adapter, kimiK26(), options);
}

export function createKimiAgent(options: KimiAgentOptions = {}): Agent {
  return agentFor(adapter, kimiK26(), options);
}
