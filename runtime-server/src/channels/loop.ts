/** Capped exponential backoff: 2 s, 4 s, 8 s ... up to five minutes. */
export const backoffMs = (attempt: number): number => Math.min(2 ** attempt * 1000, 5 * 60_000);

/**
 * Runs `step` again as soon as it reports work, and otherwise after `idleMs` or when woken.
 * `step` returns how many items it handled; it never throws into the loop.
 */
export function pollLoop(step: () => Promise<number>, options: { idleMs: number; onError: (error: unknown) => void }): { wake(): void; stop(): Promise<void> } {
  let stopped = false;
  let wake = () => undefined as void;
  const run = (async () => {
    while (!stopped) {
      const handled = await step().catch(error => { options.onError(error); return 0; });
      if (handled === 0 && !stopped) await new Promise<void>(resolve => { const timer = setTimeout(resolve, options.idleMs); wake = () => { clearTimeout(timer); resolve(); }; });
    }
  })();
  return { wake: () => wake(), stop: async () => { stopped = true; wake(); await run; } };
}
