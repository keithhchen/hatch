import { trace } from "@opentelemetry/api";
import { currentContext } from "./context.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
export type LogEntry = { ts: string; level: LogLevel; event: string; service?: string; fields: LogFields };

/** Where entries go. Today: stdout JSON, which Vector ships to Axiom. */
export interface LogSink { write(entry: LogEntry): void }

/** The domain-level port: name an event, attach fields; the bound and request context ride along. */
export interface Log {
  event(level: LogLevel, name: string, fields?: LogFields): void;
  debug(name: string, fields?: LogFields): void;
  info(name: string, fields?: LogFields): void;
  warn(name: string, fields?: LogFields): void;
  error(name: string, fields?: LogFields): void;
  child(bound: LogFields): Log;
}

const plain = (value: unknown): unknown => value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;

export class Logger implements Log {
  constructor(private readonly sinks: () => readonly LogSink[], private readonly bound: LogFields = {}, private readonly service: () => string | undefined = () => process.env.HATCH_SERVICE_NAME?.trim() || undefined) {}

  event(level: LogLevel, name: string, fields: LogFields = {}): void {
    const merged: LogFields = { ...currentContext(), ...this.bound };
    for (const [key, value] of Object.entries(fields)) merged[key] = plain(value);
    const service = this.service();
    const entry: LogEntry = { ts: new Date().toISOString(), level, event: name, ...(service ? { service } : {}), fields: merged };
    for (const sink of this.sinks()) { try { sink.write(entry); } catch { /* logging never breaks the caller */ } }
  }
  debug(name: string, fields?: LogFields): void { this.event("debug", name, fields); }
  info(name: string, fields?: LogFields): void { this.event("info", name, fields); }
  warn(name: string, fields?: LogFields): void { this.event("warn", name, fields); }
  error(name: string, fields?: LogFields): void { this.event("error", name, fields); }
  child(bound: LogFields): Log { return new Logger(this.sinks, { ...this.bound, ...bound }, this.service); }
}

/** One JSON line per entry. warn/error go to stderr, the rest to stdout, through console so they stay capturable. */
export class StdoutJsonSink implements LogSink {
  write({ ts, level, event, service, fields }: LogEntry): void {
    const span = trace.getActiveSpan()?.spanContext();
    const ids = span && trace.isSpanContextValid(span) ? { trace_id: span.traceId, span_id: span.spanId } : {};
    const line = JSON.stringify({ ts, level, event, ...(service ? { service } : {}), ...ids, ...fields });
    if (level === "warn" || level === "error") console.error(line); else console.log(line);
  }
}

const sinks: LogSink[] = [new StdoutJsonSink()];

/** The process's root log; `HATCH_SERVICE_NAME` (registry, runtime, dashboard) names the emitting service. */
export const log: Log = new Logger(() => sinks);
