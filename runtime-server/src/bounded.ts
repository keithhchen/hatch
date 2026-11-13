/** Concurrency helpers for fan-out work that shares a small database pool. */

/** `fn` over `items`, at most `limit` at a time; results keep the order of `items`. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index]!); }
  }));
  return results;
}

/** Callers that ask for the same key while it is being computed share one computation; a failure is not remembered. */
export function singleFlight<K, V>(compute: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const flights = new Map<K, Promise<V>>();
  return (key) => {
    let flight = flights.get(key);
    if (!flight) {
      flight = compute(key).finally(() => flights.delete(key));
      flights.set(key, flight);
    }
    return flight;
  };
}
