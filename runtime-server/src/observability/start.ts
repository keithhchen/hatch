import { installPropagatingFetch } from "./http.js";
import { initializeOtelExport } from "./otel.js";

/** Once per process, at startup: name the service, forward request ids on outbound fetches, start OTLP export if configured. */
export function startObservability(service: string): void {
  process.env.HATCH_SERVICE_NAME ??= service;
  // The OpenTelemetry resource reads its name from here; without it every export is "unknown_service:node".
  process.env.OTEL_SERVICE_NAME ??= process.env.HATCH_SERVICE_NAME;
  installPropagatingFetch();
  initializeOtelExport();
}
