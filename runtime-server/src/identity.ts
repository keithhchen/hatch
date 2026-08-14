import { randomUUID } from "node:crypto";

/** Canonical database identity: RFC 4122 UUID version 4, lower-case text. */
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_RE.test(value);
}

export function newIdentityId(): string {
  return randomUUID();
}

export function requireUuidV4(value: unknown, field: string): string {
  if (!isUuidV4(value)) {
    const error = new Error(`${field} must be a canonical UUID v4`) as Error & { status?: number; code?: string };
    error.status = 400;
    error.code = "invalid_uuid";
    throw error;
  }
  return value;
}
