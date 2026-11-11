import { SeverityNumber, logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { addLogSink, type LogEntry, type LogLevel, type LogSink } from "./log.js";

const SEVERITY: Record<LogLevel, SeverityNumber> = { debug: SeverityNumber.DEBUG, info: SeverityNumber.INFO, warn: SeverityNumber.WARN, error: SeverityNumber.ERROR };

/** Exporting is configured the standard way and is off when no endpoint is set. */
export const otelConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim());

/** OpenTelemetry logs adapter. An active span's trace ids attach through the ambient context. */
export class OtelLogSink implements LogSink {
  constructor(private readonly emitter = logs.getLogger("hatch")) {}
  write({ level, event, service, fields }: LogEntry): void {
    const attributes: Record<string, string | number | boolean> = { event, ...(service ? { service } : {}) };
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) attributes[key] = typeof value === "object" && value !== null ? JSON.stringify(value) : value as string | number | boolean;
    this.emitter.emit({ severityNumber: SEVERITY[level], severityText: level.toUpperCase(), body: event, attributes });
  }
}

/** Span processors for a provider someone else owns (Langfuse's SDK adds these beside its own). Empty when off. */
export const otlpSpanProcessors = (env: NodeJS.ProcessEnv = process.env): SpanProcessor[] =>
  otelConfigured(env) ? [new BatchSpanProcessor(new OTLPTraceExporter())] : [];

let started = false;

/**
 * Starts OTLP export of logs and traces when OTEL_EXPORTER_OTLP_ENDPOINT (and _HEADERS) are set; a no-op otherwise.
 * When Langfuse owns the tracing SDK it adds `otlpSpanProcessors` itself; otherwise this starts the SDK.
 */
export function initializeOtelExport(env: NodeJS.ProcessEnv = process.env): void {
  if (started || !otelConfigured(env)) return;
  started = true;
  logs.setGlobalLoggerProvider(new LoggerProvider({ processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })] }));
  addLogSink(new OtelLogSink());
  if (env.LANGFUSE_ENABLED !== "true") new NodeSDK({ spanProcessors: otlpSpanProcessors(env) }).start();
}
