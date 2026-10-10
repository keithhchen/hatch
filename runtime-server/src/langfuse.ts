import { LangfuseSpanProcessor } from "@langfuse/otel";
import { AsyncLocalStorage } from "node:async_hooks";
import { startActiveObservation, startObservation, type LangfuseGenerationAttributes } from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEventStream, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";

type LangfuseConfig = {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment?: string;
  release?: string;
};

let runtime: { sdk: NodeSDK; processor: LangfuseSpanProcessor } | undefined;
const activeTurn = new AsyncLocalStorage<{ output?: AssistantMessage }>();

export function initializeLangfuseObservability(environment: NodeJS.ProcessEnv = process.env): void {
  const enabled = environment.LANGFUSE_ENABLED;
  if (enabled === undefined || enabled === "false") return;
  if (enabled !== "true") throw new Error("LANGFUSE_ENABLED must be true or false");
  if (runtime) return;
  const config: LangfuseConfig = {
    publicKey: environment.LANGFUSE_PUBLIC_KEY?.trim() ?? "",
    secretKey: environment.LANGFUSE_SECRET_KEY?.trim() ?? "",
    baseUrl: environment.LANGFUSE_BASE_URL?.trim() ?? "",
    ...(environment.LANGFUSE_TRACING_ENVIRONMENT?.trim() ? { environment: environment.LANGFUSE_TRACING_ENVIRONMENT.trim() } : {}),
    ...(environment.LANGFUSE_RELEASE?.trim() ? { release: environment.LANGFUSE_RELEASE.trim() } : {})
  };
  if (!config.publicKey || !config.secretKey || !config.baseUrl) {
    throw new Error("Langfuse requires LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_BASE_URL");
  }
  const url = new URL(config.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("LANGFUSE_BASE_URL must be a clean HTTPS URL");
  }
  const processor = new LangfuseSpanProcessor({
    ...config,
    mask: ({ data }) => maskSecrets(data)
  });
  const sdk = new NodeSDK({ spanProcessors: [processor] });
  sdk.start();
  runtime = { sdk, processor };
}

function isEnabled(): boolean {
  initializeLangfuseObservability();
  return runtime !== undefined;
}

function maskSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\b(?:sk-lf|pk-lf)-[A-Za-z0-9-]+\b/g, "[REDACTED_LANGFUSE_KEY]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED_TOKEN]")
      .replace(/((?:api[_-]?key|secret[_-]?key|authorization|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?)[^"'\s,}]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /^(?:api[_-]?key|secret[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password)$/i.test(key)
      ? "[REDACTED]"
      : maskSecrets(item)
  ]));
}

export async function withLangfuseTurn<T>(name: string, input: unknown, operation: () => Promise<T>): Promise<T> {
  if (!isEnabled()) return operation();
  return startActiveObservation(name, observation => activeTurn.run({}, async () => {
    observation.update({ input });
    try {
      const result = await operation();
      const output = activeTurn.getStore()?.output;
      if (output) observation.update({ output });
      return result;
    } catch (error) {
      observation.update({ level: "ERROR", statusMessage: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }), { asType: "agent" });
}

export function traceAgentTools(tools: AgentTool[]): AgentTool[] {
  if (!isEnabled()) return tools;
  return tools.map(tool => ({
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) => startActiveObservation(
      tool.name,
      async observation => {
        observation.update({ input: params });
        try {
          const result = await tool.execute(toolCallId, params, signal, onUpdate);
          observation.update({ output: result });
          return result;
        } catch (error) {
          observation.update({ level: "ERROR", statusMessage: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      },
      { asType: "tool" }
    )
  }));
}

function generationAttributes(message: AssistantMessage): LangfuseGenerationAttributes {
  const usage = message.usage;
  return {
    output: message,
    usageDetails: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      total: usage.totalTokens
    },
    costDetails: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total
    },
    ...(message.stopReason === "error" ? { level: "ERROR" as const, statusMessage: message.errorMessage } : {}),
    ...(message.stopReason === "aborted" ? { level: "WARNING" as const } : {})
  };
}

export function traceProviderStream(
  createSource: () => AssistantMessageEventStream,
  model: { id: string; provider: string },
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  if (!isEnabled()) return createSource();
  const generation = startObservation("generate-response", {
    model: model.id,
    input: context,
    metadata: { provider: model.provider },
    modelParameters: {
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options?.reasoning !== undefined ? { reasoning: options.reasoning } : {})
    }
  }, { asType: "generation" });
  let source: AssistantMessageEventStream;
  try {
    source = createSource();
  } catch (error) {
    generation.update({ level: "ERROR", statusMessage: error instanceof Error ? error.message : String(error) });
    generation.end();
    throw error;
  }
  const turn = activeTurn.getStore();
  void source.result().then(
    message => {
      generation.update(generationAttributes(message));
      generation.end();
      if (turn) turn.output = message;
    },
    error => {
      generation.update({ level: "ERROR", statusMessage: error instanceof Error ? error.message : String(error) });
      generation.end();
    }
  );
  return source;
}

export async function flushLangfuseObservability(): Promise<void> {
  if (runtime) await runtime.processor.forceFlush();
}

export async function shutdownLangfuseObservability(): Promise<void> {
  if (!runtime) return;
  const current = runtime;
  runtime = undefined;
  await current.sdk.shutdown();
}
