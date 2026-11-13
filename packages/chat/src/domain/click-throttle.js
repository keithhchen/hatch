/** Ignores a click that follows another within `windowMs`; the first click always goes through. */
export function createClickThrottle({ windowMs = 400, now = Date.now } = {}) {
  let last = -Infinity;
  return action => {
    const time = now();
    if (time - last < windowMs) return;
    last = time;
    action();
  };
}
