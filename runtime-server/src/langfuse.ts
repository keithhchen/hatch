import { LangfuseSpanProcessor } from "@langfuse/otel";
import { AsyncLocalStorage } from "node:async_hooks";
import { propagateAttributes, startActiveObservation, startObservation, type LangfuseGenerationAttributes } from "@langfuse/tracing";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Context, type SimpleStreamOptions } from "@earendil-works/pi-ai";

type LangfuseConfig = {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment?: string;
  release?: string;
};

export type LangfuseTurnIdentifiers = {
  productId: string;
  userId: string;
  conversationId?: string;
  requestId?: string;
};

/** Who a traced call is for. Every field is optional; a call inside a turn inherits the turn's. */
export type LangfuseContext = { userId?: string; sessionId?: string; requestId?: string };

export type LangfuseCall = LangfuseContext & {
  /** A model call is a "generation"; anything else is a "span". */
  type?: "generation" | "span";
  model?: string;
  provider?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
};

/** What a finished call reports. `failed` marks the observation as an error without throwing. */
export type LangfuseResult = {
  output?: unknown;
  usage?: { input?: number; output?: number; total?: number };
  metadata?: Record<string, unknown>;
  failed?: string;
};

type SpanExporter = NonNullable<NonNullable<ConstructorParameters<typeof LangfuseSpanProcessor>[0]>["exporter"]>;

let runtime: { sdk: NodeSDK; processor: LangfuseSpanProcessor } | undefined;
const activeTurn = new AsyncLocalStorage<{ output?: AssistantMessage }>();
const activeAttempt = new AsyncLocalStorage<number>();

/** Runs `operation` so the generations it starts say which attempt of a retried call they are. */
export const labelAttempt = <T>(attempt: number, operation: () => T): T => activeAttempt.run(attempt, operation);

/** Wraps an exporter so a failed export is one warning line, at most once per `intervalMs`. */
export function reportExportFailures(
  delegate: SpanExporter,
  log: (line: string) => void = line => console.error(line),
  now: () => number = Date.now,
  intervalMs = 60_000
): SpanExporter {
  let last = -Infinity;
  return {
    export: (spans, done) => delegate.export(spans, result => {
      if (result.code !== 0 && now() - last >= intervalMs) {
        last = now();
        log(JSON.stringify({ event: "langfuse_export_failed", spans: spans.length, error: result.error?.message ?? "export failed" }));
      }
      done(result);
    }),
    shutdown: () => delegate.shutdown(),
    ...(delegate.forceFlush ? { forceFlush: () => delegate.forceFlush!() } : {})
  };
}

export function initializeLangfuseObservability(environment: NodeJS.ProcessEnv = process.env, options: { exporter?: SpanExporter } = {}): void {
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
  const delegate = options.exporter ?? new OTLPTraceExporter({
    url: `${config.baseUrl}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
      "x-langfuse-sdk-name": "javascript",
      "x-langfuse-public-key": config.publicKey
    }
  });
  const processor = new LangfuseSpanProcessor({
    ...config,
    exporter: reportExportFailures(delegate),
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

export async function withLangfuseTurn<T>(
  name: string,
  input: unknown,
  operation: () => Promise<T>,
  identifiers?: LangfuseTurnIdentifiers
): Promise<T> {
  if (!isEnabled()) return operation();
  const run = () => startActiveObservation(name, observation => activeTurn.run({}, async () => {
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
  if (!identifiers) return run();
  return propagateAttributes({
    userId: identifiers.userId,
    ...(identifiers.conversationId ? { sessionId: identifiers.conversationId } : {}),
    metadata: {
      productId: identifiers.productId,
      ...(identifiers.requestId ? { request_id: identifiers.requestId } : {}),
      ...(identifiers.conversationId ? { conversationId: identifiers.conversationId } : {})
    }
  }, run);
}

const failureOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Runs `fn` with the call's user, session and request id attached to every observation it starts. */
export function withLangfuseContext<T>(context: LangfuseContext, fn: () => T): T {
  if (!context.userId && !context.sessionId && !context.requestId) return fn();
  return propagateAttributes({
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.requestId ? { metadata: { request_id: context.requestId } } : {})
  }, fn);
}

const startAttributes = (call: LangfuseCall) => ({
  ...(call.model ? { model: call.model } : {}),
  ...(call.input !== undefined ? { input: call.input } : {}),
  metadata: { ...(call.provider ? { provider: call.provider } : {}), ...call.metadata }
});

const resultAttributes = (result: LangfuseResult) => ({
  ...(result.output !== undefined ? { output: result.output } : {}),
  ...(result.usage ? { usageDetails: result.usage } : {}),
  ...(result.metadata ? { metadata: result.metadata } : {}),
  ...(result.failed ? { level: "ERROR", statusMessage: result.failed } : {})
});

/**
 * Traces one call as an observation: duration, error status, and whatever `describe` reads off the result
 * (output, token usage). The wrapped function neither knows nor cares whether tracing is on.
 */
export async function traceObservation<T>(
  name: string,
  call: LangfuseCall,
  operation: () => Promise<T>,
  describe?: (result: T) => LangfuseResult
): Promise<T> {
  if (!isEnabled()) return operation();
  return withLangfuseContext(call, () => startActiveObservation(name, async observation => {
    observation.update(startAttributes(call) as never);
    try {
      const result = await operation();
      if (describe) observation.update(resultAttributes(describe(result)) as never);
      return result;
    } catch (error) {
      observation.update({ level: "ERROR", statusMessage: failureOf(error) });
      throw error;
    }
  }, { asType: (call.type ?? "span") as "span" }));
}

/** `traceObservation` for a model call: it carries the model, provider and token usage. */
export const traceGeneration = <T>(name: string, call: LangfuseCall, operation: () => Promise<T>, describe?: (result: T) => LangfuseResult): Promise<T> =>
  traceObservation(name, { ...call, type: "generation" }, operation, describe);

/** Token usage as OpenAI-compatible and DashScope responses report it; nothing when the response has none. */
export function usageOf(raw: unknown): LangfuseResult["usage"] {
  if (!raw || typeof raw !== "object") return undefined;
  const { prompt_tokens, input_tokens, completion_tokens, output_tokens, total_tokens } = raw as Record<string, unknown>;
  const count = (value: unknown) => typeof value === "number" ? value : undefined;
  const usage = { input: count(prompt_tokens) ?? count(input_tokens), output: count(completion_tokens) ?? count(output_tokens), total: count(total_tokens) };
  return Object.values(usage).some(value => value !== undefined) ? Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined)) : undefined;
}

export type OpenObservation = { update(result: LangfuseResult): void; end(failure?: unknown): void };

/** An observation for something long-lived (a live session, a socket): opened now, closed when it ends. */
export function openObservation(name: string, call: LangfuseCall): OpenObservation {
  if (!isEnabled()) return { update() {}, end() {} };
  const observation = withLangfuseContext(call, () => startObservation(name, startAttributes(call) as never, { asType: (call.type ?? "span") as "span" }));
  let ended = false;
  return {
    update: result => { if (!ended) observation.update(resultAttributes(result) as never); },
    end: failure => {
      if (ended) return;
      ended = true;
      if (failure !== undefined) observation.update({ level: "ERROR", statusMessage: failureOf(failure) });
      observation.end();
    }
  };
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

function hasCompletionDelta(event: AssistantMessageEvent): boolean {
  return (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
    && event.delta.length > 0;
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
    metadata: {
      provider: model.provider,
      ...(activeAttempt.getStore() !== undefined ? { attempt: activeAttempt.getStore(), retry: activeAttempt.getStore()! > 0 } : {})
    },
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
  const forwarded = createAssistantMessageEventStream();
  const turn = activeTurn.getStore();
  void (async () => {
    let recordedFirstToken = false;
    let recordedResult = false;
    const recordResult = (message: AssistantMessage) => {
      generation.update(generationAttributes(message));
      generation.end();
      if (turn) turn.output = message;
    };
    for await (const event of source) {
      if (!recordedFirstToken && hasCompletionDelta(event)) {
        recordedFirstToken = true;
        generation.update({ completionStartTime: new Date() });
      }
      if (event.type === "done" || event.type === "error") {
        recordedResult = true;
        recordResult(event.type === "done" ? event.message : event.error);
      }
      forwarded.push(event);
    }
    const result = await source.result();
    if (!recordedResult) recordResult(result);
    forwarded.end(result);
  })();
  return forwarded;
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
