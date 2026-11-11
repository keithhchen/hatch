import { installPropagatingFetch } from "./http.js";
import { initializeOtelExport } from "./otel.js";

/** Once per process, at startup: name the service, forward request ids on outbound fetches, start OTLP export if configured. */
export function startObservability(service: string): void {
  process.env.HATCH_SERVICE_NAME ??= service;
  installPropagatingFetch();
  initializeOtelExport();
}
