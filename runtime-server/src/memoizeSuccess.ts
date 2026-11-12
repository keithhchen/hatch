/** Runs `fn` once and shares its result, concurrent callers included. A rejection is not remembered: the next call retries. */
export const memoizeSuccess = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () => pending ??= fn().catch(error => { pending = undefined; throw error; });
};
