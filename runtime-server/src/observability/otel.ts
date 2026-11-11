import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";

/** Exporting is configured the standard way and is off when no endpoint is set. */
export const otelConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim());

/** Span processors for a provider someone else owns (Langfuse's SDK adds these beside its own). Empty when off. */
export const otlpSpanProcessors = (env: NodeJS.ProcessEnv = process.env): SpanProcessor[] =>
  otelConfigured(env) ? [new BatchSpanProcessor(new OTLPTraceExporter())] : [];

let started = false;

/**
 * Starts OTLP trace export when OTEL_EXPORTER_OTLP_ENDPOINT (and _HEADERS) are set; a no-op otherwise.
 * When Langfuse owns the tracing SDK it adds `otlpSpanProcessors` itself; otherwise this starts the SDK.
 */
export function initializeOtelExport(env: NodeJS.ProcessEnv = process.env): void {
  if (started || !otelConfigured(env)) return;
  started = true;
  if (env.LANGFUSE_ENABLED !== "true") new NodeSDK({ spanProcessors: otlpSpanProcessors(env) }).start();
}
