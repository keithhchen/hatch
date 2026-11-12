import { createHash } from "node:crypto";

/** The same Idempotency-Key was sent with a different request. */
export class IdempotencyKeyReused extends Error {
  constructor() { super("This Idempotency-Key was already used for a different request."); }
}

/** A UUID that is the same for the same parts: a record stored under it can be found again from the key alone. */
export const deterministicId = (...parts: string[]): string => {
  const hex = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** The header value, or undefined when absent. */
export const idempotencyKey = (header: string | string[] | undefined): string | undefined => {
  const key = (Array.isArray(header) ? header[0] : header)?.trim();
  if (!key) return undefined;
  if (key.length > 255) throw new RangeError("Idempotency-Key may be at most 255 characters");
  return key;
};

/** Where a created record lives: `create` is false when its id is taken, so a race is settled by the store, not by a check. */
export interface Once<T> { create(value: T): Promise<boolean>; find(value: T): Promise<T | undefined> }

/**
 * Makes creating a record safe to repeat: the first call stores it; a repeat returns the stored one,
 * or throws when the repeat is not the same request (`same`).
 */
export const idempotent = <T>(store: Once<T>, same: (stored: T, fresh: T) => boolean) =>
  async (fresh: T): Promise<{ value: T; replayed: boolean }> => {
    if (await store.create(fresh)) return { value: fresh, replayed: false };
    const stored = await store.find(fresh);
    if (!stored || !same(stored, fresh)) throw new IdempotencyKeyReused();
    return { value: stored, replayed: true };
  };
