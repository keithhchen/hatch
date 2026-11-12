import path from "node:path";
import { MAX_CONSUMER_BUFFERED_BYTES } from "./chat/sinks.js";

/** Everything the Runtime reads from its environment, parsed and checked, before any adapter is built. */
export type RuntimeConfig = {
  registryUrl?: string;
  corpusRoot?: string;
  dataDir: string;
  registryToken?: string;
  host: string;
  insecureLocalMode: boolean;
  helloTimeoutMs: number;
  maxPendingTurnAuthorizations: number;
  maxPendingTurnAuthorizationsPerUser: number;
  maxActiveRunsGlobal: number;
  maxActiveRunsPerUser: number;
  maxSocketBufferedBytes: number;
  maxConsumerBufferedBytes: number;
  connectionHeartbeatMs: number;
  connectionIdleTimeoutMs: number;
  serverToolTimeoutMs: number;
  httpHeadersTimeoutMs: number;
  httpRequestTimeoutMs: number;
  maxHttpResponseBytes: number;
  maxContactMessages: number;
  clientToolTimeoutMs: number;
  allowedOrigins: string[];
  chatServiceToken?: string;
  legacyHmacEnabled: boolean;
  legacyHmacSecret?: string;
};

/** What one contact may send to one Product, in all; the Registry's rate limit bounds how fast. */
export const DEFAULT_MAX_CONTACT_MESSAGES = 1_000;

/** Reads and validates the environment: capacity limits, deadlines, and the loopback / insecure-local gate. */
export function readRuntimeConfig(environment: NodeJS.ProcessEnv): RuntimeConfig {
  const registryUrl = environment.HATCH_REGISTRY_URL?.trim();
  const runtimeCorpusRoot = environment.HATCH_RUNTIME_CORPUS_ROOT?.trim();
  const runtimeDataDir = environment.HATCH_RUNTIME_DATA_DIR?.trim() || path.resolve(".hatch-runtime");
  const runtimeRegistryToken = environment.HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN?.trim();
  const runtimeDatabaseUrl = environment.HATCH_RUNTIME_DATABASE_URL?.trim();
  const runtimeHost = environment.HATCH_RUNTIME_HOST?.trim() || "127.0.0.1";
  const helloTimeoutMs = runtimeClientHelloTimeoutMs(environment.HATCH_RUNTIME_HELLO_TIMEOUT_MS);
  const maxPendingTurnAuthorizations = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_PENDING_TURN_AUTHORIZATIONS",
    environment.HATCH_RUNTIME_MAX_PENDING_TURN_AUTHORIZATIONS,
    16
  );
  const maxPendingTurnAuthorizationsPerUser = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_PENDING_TURN_AUTHORIZATIONS_PER_USER",
    environment.HATCH_RUNTIME_MAX_PENDING_TURN_AUTHORIZATIONS_PER_USER,
    4
  );
  const maxActiveRunsGlobal = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_ACTIVE_RUNS_GLOBAL",
    environment.HATCH_RUNTIME_MAX_ACTIVE_RUNS_GLOBAL,
    16,
    10_000
  );
  const maxActiveRunsPerUser = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_ACTIVE_RUNS_PER_USER",
    environment.HATCH_RUNTIME_MAX_ACTIVE_RUNS_PER_USER,
    2,
    10_000
  );
  const maxSocketBufferedBytes = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_SOCKET_BUFFERED_BYTES",
    environment.HATCH_RUNTIME_MAX_SOCKET_BUFFERED_BYTES,
    160 * 1024 * 1024,
    256 * 1024 * 1024
  );
  const maxConsumerBufferedBytes = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_CONSUMER_BUFFERED_BYTES",
    environment.HATCH_RUNTIME_MAX_CONSUMER_BUFFERED_BYTES,
    MAX_CONSUMER_BUFFERED_BYTES,
    256 * 1024 * 1024
  );
  const connectionHeartbeatMs = runtimeDurationMs(
    "HATCH_RUNTIME_CONNECTION_HEARTBEAT_MS",
    environment.HATCH_RUNTIME_CONNECTION_HEARTBEAT_MS,
    30_000,
    1_000,
    300_000
  );
  const connectionIdleTimeoutMs = runtimeDurationMs(
    "HATCH_RUNTIME_CONNECTION_IDLE_TIMEOUT_MS",
    environment.HATCH_RUNTIME_CONNECTION_IDLE_TIMEOUT_MS,
    1_800_000,
    60_000,
    86_400_000
  );
  const serverToolTimeoutMs = runtimeDurationMs(
    "HATCH_RUNTIME_SERVER_TOOL_TIMEOUT_MS",
    environment.HATCH_RUNTIME_SERVER_TOOL_TIMEOUT_MS,
    120_000,
    1_000,
    300_000
  );
  const httpHeadersTimeoutMs = runtimeDurationMs(
    "HATCH_RUNTIME_HTTP_HEADERS_TIMEOUT_MS",
    environment.HATCH_RUNTIME_HTTP_HEADERS_TIMEOUT_MS,
    5_000,
    1_000,
    60_000
  );
  const httpRequestTimeoutMs = runtimeDurationMs(
    "HATCH_RUNTIME_HTTP_REQUEST_TIMEOUT_MS",
    environment.HATCH_RUNTIME_HTTP_REQUEST_TIMEOUT_MS,
    10_000,
    1_000,
    120_000
  );
  const maxHttpResponseBytes = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_HTTP_RESPONSE_BYTES",
    environment.HATCH_RUNTIME_MAX_HTTP_RESPONSE_BYTES,
    64 * 1024 * 1024,
    64 * 1024 * 1024
  );
  const insecureLocalMode = explicitBooleanEnvironmentFlag(
    "HATCH_ALLOW_INSECURE_LOCAL_MODE",
    environment.HATCH_ALLOW_INSECURE_LOCAL_MODE
  );
  if (registryUrl) {
    const parsedRegistryUrl = new URL(registryUrl);
    if (parsedRegistryUrl.protocol !== "http:" && parsedRegistryUrl.protocol !== "https:") {
      throw new Error("HATCH_REGISTRY_URL must use http or https");
    }
  }
  if (registryUrl && !runtimeRegistryToken && environment.NODE_ENV === "production") {
    throw new Error("HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN is required when HATCH_REGISTRY_URL is configured");
  }
  if (!isLoopbackRuntimeHost(runtimeHost)
    && !insecureLocalMode
    && (!registryUrl || !runtimeRegistryToken || !runtimeCorpusRoot || !runtimeDatabaseUrl)) {
    throw new Error(
      "A non-loopback Runtime requires HATCH_REGISTRY_URL, HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN, "
      + "HATCH_RUNTIME_CORPUS_ROOT, and HATCH_RUNTIME_DATABASE_URL; "
      + "set HATCH_ALLOW_INSECURE_LOCAL_MODE=true only for an intentional local fixture"
    );
  }
  const legacyHmacEnabled = legacyHmacAuthEnabled(environment.HATCH_ENABLE_LEGACY_HMAC_AUTH);
  const legacyHmacSecret = environment.HATCH_AUTH_SIGNING_SECRET?.trim() || undefined;
  if (legacyHmacEnabled && !legacyHmacSecret) {
    throw new Error("HATCH_AUTH_SIGNING_SECRET is required when legacy HMAC auth is enabled");
  }
  return {
    registryUrl,
    corpusRoot: runtimeCorpusRoot,
    dataDir: runtimeDataDir,
    registryToken: runtimeRegistryToken,
    host: runtimeHost,
    insecureLocalMode,
    helloTimeoutMs,
    maxPendingTurnAuthorizations,
    maxPendingTurnAuthorizationsPerUser,
    maxActiveRunsGlobal,
    maxActiveRunsPerUser,
    maxSocketBufferedBytes,
    maxConsumerBufferedBytes,
    connectionHeartbeatMs,
    connectionIdleTimeoutMs,
    serverToolTimeoutMs,
    httpHeadersTimeoutMs,
    httpRequestTimeoutMs,
    maxHttpResponseBytes,
    maxContactMessages: runtimeCapacityLimit("HATCH_RUNTIME_MAX_CONTACT_MESSAGES", environment.HATCH_RUNTIME_MAX_CONTACT_MESSAGES, DEFAULT_MAX_CONTACT_MESSAGES, 10_000_000),
    clientToolTimeoutMs: clientToolTimeoutMs(environment.HATCH_CLIENT_TOOL_TIMEOUT_MS),
    allowedOrigins: (environment.HATCH_RUNTIME_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
    chatServiceToken: environment.HATCH_RUNTIME_CHAT_SERVICE_TOKEN?.trim() || undefined,
    legacyHmacEnabled,
    legacyHmacSecret
  };
}

export function legacyHmacAuthEnabled(raw: string | undefined): boolean {
  return explicitBooleanEnvironmentFlag("HATCH_ENABLE_LEGACY_HMAC_AUTH", raw);
}

function explicitBooleanEnvironmentFlag(name: string, raw: string | undefined): boolean {
  const value = raw?.trim();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be exactly true or false`);
}

function isLoopbackRuntimeHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function clientToolTimeoutMs(raw = process.env.HATCH_CLIENT_TOOL_TIMEOUT_MS): number {
  // The Desktop keeps a pending write visible while the buyer reviews it.
  // Two minutes is shorter than a normal interruption, while an unbounded
  // pending call would retain a dead browser connection forever.
  if (raw === undefined || raw === "") return 300_000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 30_000 || parsed > 1_800_000) {
    throw new Error("HATCH_CLIENT_TOOL_TIMEOUT_MS must be an integer between 30000 and 1800000");
  }
  return parsed;
}

export function runtimeClientHelloTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 10_000;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 60_000) {
    throw new Error("HATCH_RUNTIME_HELLO_TIMEOUT_MS must be an integer between 1000 and 60000");
  }
  return parsed;
}

function runtimeCapacityLimit(
  name: string,
  raw: string | undefined,
  defaultValue: number,
  maximum = 1_024
): number {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function runtimeDurationMs(
  name: string,
  raw: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export class CapacityGate {
  private pending = 0;

  constructor(private readonly capacity: number, optionName: string) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error(`${optionName} must be a positive safe integer`);
    }
  }

  tryAcquire(): (() => void) | undefined {
    if (this.pending >= this.capacity) return undefined;
    this.pending += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pending -= 1;
    };
  }
}

export class KeyedCapacityGate {
  private readonly pending = new Map<string, number>();

  constructor(private readonly capacityPerKey: number, optionName: string) {
    if (!Number.isSafeInteger(capacityPerKey) || capacityPerKey < 1) {
      throw new Error(`${optionName} must be a positive safe integer`);
    }
  }

  tryAcquire(key: string): (() => void) | undefined {
    const current = this.pending.get(key) ?? 0;
    if (current >= this.capacityPerKey) return undefined;
    this.pending.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.pending.get(key) ?? 1) - 1;
      if (next <= 0) this.pending.delete(key);
      else this.pending.set(key, next);
    };
  }
}

export function combineCapacityReleases(...releases: Array<() => void>): () => void {
  return () => {
    for (const release of releases) release();
  };
}

export function once(release: () => void): () => void {
  let released = false;
  return () => { if (!released) { released = true; release(); } };
}
