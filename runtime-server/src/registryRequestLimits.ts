export type HttpRequestLimitOptions = {
  headersTimeoutMs: number;
  requestTimeoutMs: number;
};

export function httpRequestLimitOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): HttpRequestLimitOptions {
  const options = {
    headersTimeoutMs: integerSetting(environment, "HATCH_REGISTRY_HTTP_HEADERS_TIMEOUT_MS", 10_000, 1_000, 120_000),
    requestTimeoutMs: integerSetting(environment, "HATCH_REGISTRY_HTTP_REQUEST_TIMEOUT_MS", 30_000, 1_000, 10 * 60 * 1000),
  };
  if (options.headersTimeoutMs > options.requestTimeoutMs) {
    throw new Error("HATCH_REGISTRY_HTTP_HEADERS_TIMEOUT_MS must not exceed HATCH_REGISTRY_HTTP_REQUEST_TIMEOUT_MS");
  }
  return options;
}

function integerSetting(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
