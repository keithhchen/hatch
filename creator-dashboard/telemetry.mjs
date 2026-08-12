import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export const PORTAL_FUNNEL_EVENTS = Object.freeze(new Set([
  "catalog_viewed", "product_viewed", "auth_started", "auth_completed",
  "checkout_started", "checkout_confirmed", "payment_succeeded", "payment_failed",
  "entitlement_activated", "desktop_open_clicked", "desktop_download_clicked",
  "delivery_reserved", "delivery_completed", "factory_draft_started", "factory_draft_saved",
  "candidate_ready", "candidate_approved", "candidate_rejected", "offer_saved",
  "preview_viewed", "publish_started", "publish_succeeded", "publish_failed",
  "share_link_copied"
]));

const ALLOWED_ATTRIBUTES = new Set([
  "product_id", "creator_id", "offer_id", "offer_revision", "release_id",
  "release_version", "anonymous_session_id", "request_id", "correlation_id",
  "platform", "duration_ms", "error_category"
]);

export class PortalTelemetryStore {
  #pool;
  #ownsPool = false;
  #events = new Map();

  constructor(options = {}) {
    this.#pool = options.pool;
    this.#ownsPool = options.ownsPool === true;
    this.filePath = options.filePath;
    for (const event of options.events ?? []) this.#events.set(event.idempotency_key, event);
  }

  static async open(options = {}) {
    if (options.pool || options.Pool || options.connectionString) {
      const pool = options.pool ?? new options.Pool({
        connectionString: options.connectionString,
        ...(options.poolOptions ?? {})
      });
      const ownsPool = !options.pool;
      try {
        await pool.query(`CREATE TABLE IF NOT EXISTS portal_telemetry_events (
          event_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          event_name TEXT NOT NULL,
          occurred_at TIMESTAMPTZ NOT NULL,
          attributes JSONB NOT NULL,
          payload_digest TEXT NOT NULL
        )`);
        await pool.query("CREATE INDEX IF NOT EXISTS portal_telemetry_name_time_idx ON portal_telemetry_events (event_name, occurred_at)");
        return new PortalTelemetryStore({ pool, ownsPool });
      } catch (error) {
        if (ownsPool) await pool.end?.().catch(() => undefined);
        throw error;
      }
    }
    let events = [];
    if (options.filePath) {
      try {
        events = (await readFile(options.filePath, "utf8"))
          .split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return new PortalTelemetryStore({ ...options, events });
  }

  async record(eventName, attributes, options = {}) {
    const name = String(eventName ?? "");
    if (!PORTAL_FUNNEL_EVENTS.has(name)) throw telemetryError("unsupported_telemetry_event", "Telemetry event is not allowlisted.");
    const idempotencyKey = String(options.idempotencyKey ?? "").trim();
    if (!idempotencyKey) throw telemetryError("idempotency_required", "Telemetry requires an Idempotency-Key.");
    const safeAttributes = normalizeAttributes(attributes);
    const payloadDigest = digest({ event_name: name, attributes: safeAttributes });

    if (this.#pool) {
      const existing = await this.#pool.query(
        "SELECT * FROM portal_telemetry_events WHERE idempotency_key = $1",
        [idempotencyKey]
      );
      if (existing.rows[0]) return assertReplay(existing.rows[0], payloadDigest);
      const event = telemetryEvent(name, safeAttributes, idempotencyKey, payloadDigest, options.now);
      const inserted = await this.#pool.query(
        `INSERT INTO portal_telemetry_events
          (event_id, idempotency_key, event_name, occurred_at, attributes, payload_digest)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [event.event_id, event.idempotency_key, event.event_name, event.occurred_at, JSON.stringify(event.attributes), event.payload_digest]
      );
      if (inserted.rows[0]) return rowEvent(inserted.rows[0]);
      const raced = await this.#pool.query(
        "SELECT * FROM portal_telemetry_events WHERE idempotency_key = $1",
        [idempotencyKey]
      );
      return assertReplay(raced.rows[0], payloadDigest);
    }

    const existing = this.#events.get(idempotencyKey);
    if (existing) return assertReplay(existing, payloadDigest);
    const event = telemetryEvent(name, safeAttributes, idempotencyKey, payloadDigest, options.now);
    if (this.filePath) {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    }
    this.#events.set(idempotencyKey, event);
    return structuredClone(event);
  }

  async summary() {
    if (this.#pool) {
      const result = await this.#pool.query(
        "SELECT event_name, COUNT(*)::int AS count FROM portal_telemetry_events GROUP BY event_name ORDER BY event_name"
      );
      return Object.fromEntries(result.rows.map((row) => [row.event_name, Number(row.count)]));
    }
    const counts = {};
    for (const event of this.#events.values()) counts[event.event_name] = (counts[event.event_name] ?? 0) + 1;
    return counts;
  }

  async ready() { if (this.#pool) await this.#pool.query("SELECT 1"); return true; }
  async close() { if (this.#ownsPool) await this.#pool?.end?.(); }
}

function normalizeAttributes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!ALLOWED_ATTRIBUTES.has(key)) throw telemetryError("private_telemetry_field", `Telemetry attribute ${key} is not allowed.`);
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw === "number") {
      if (!Number.isFinite(raw)) throw telemetryError("invalid_telemetry_attribute", `Telemetry attribute ${key} must be finite.`);
      output[key] = raw;
      continue;
    }
    if (typeof raw === "boolean") { output[key] = raw; continue; }
    if (typeof raw !== "string") throw telemetryError("invalid_telemetry_attribute", `Telemetry attribute ${key} must be scalar.`);
    output[key] = raw.slice(0, 200);
  }
  return output;
}

function telemetryEvent(eventName, attributes, idempotencyKey, payloadDigest, now) {
  return {
    event_id: `telemetry_${randomUUID().replaceAll("-", "")}`,
    idempotency_key: idempotencyKey,
    event_name: eventName,
    occurred_at: new Date(now ?? Date.now()).toISOString(),
    attributes,
    payload_digest: payloadDigest
  };
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function assertReplay(event, digestValue) {
  if (!event || event.payload_digest !== digestValue) throw telemetryError("idempotency_conflict", "Telemetry key was reused for a different payload.", 409);
  return rowEvent(event);
}

function rowEvent(row) {
  return {
    event_id: row.event_id,
    idempotency_key: row.idempotency_key,
    event_name: row.event_name,
    occurred_at: new Date(row.occurred_at).toISOString(),
    attributes: typeof row.attributes === "string" ? JSON.parse(row.attributes) : structuredClone(row.attributes),
    payload_digest: row.payload_digest
  };
}

function telemetryError(code, message, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
