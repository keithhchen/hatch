/**
 * Keeps a platform's typing indicator alive: it expires within seconds, and an Agent's reply takes longer. `beat` shows it once;
 * it is repeated every `everyMs` for as long as `waiting` says someone still awaits the reply, and for `maxMs` at most.
 * Best effort: a failing `beat` or `waiting` never reaches the caller.
 */
export async function keepTyping(beat: () => Promise<unknown>, waiting: () => Promise<boolean>, { everyMs, maxMs }: { everyMs: number; maxMs: number }): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline && await waiting().catch(() => false)) {
    await beat().catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, everyMs));
  }
}
