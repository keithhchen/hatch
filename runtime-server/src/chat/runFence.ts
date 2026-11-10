import type { RunHold } from "../runHold.js";

export { RunFenced } from "../runHold.js";

/** Where, among a write's arguments, the hold goes: the write's own statement checks it, so there is no gap to write in. */
type HoldAt = number;

/**
 * Fences an executor: wraps `target` so each listed write carries the hold of this executor, and the store
 * applies it as a condition of the write itself (the `executor_id` in the UPDATE's WHERE, the lock in the
 * INSERT). A stopped executor, or one whose Run another instance took over, can no longer write whatever it is
 * still in the middle of, and no stop can slip between a check and the write.
 */
export function fenced<T extends object>(target: T, executorId: string, writes: { [K in keyof T]?: HoldAt }): T {
  const hold: RunHold = { heldBy: executorId };
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key, object);
      if (typeof value !== "function") return value;
      const at = writes[key as keyof T];
      if (at === undefined) return value.bind(object);
      return (...args: unknown[]) => {
        const held = [...args];
        held[at] = hold;
        return value.apply(object, held);
      };
    }
  });
}
