/** Wraps a handler so the event is tracked first and the handler always runs, whatever the tracker does. */
export const withTracking = (analytics, event) => (handler) => (...args) => {
  try { analytics.track(typeof event === "function" ? event(...args) : event); } catch { /* tracking never blocks the handler */ }
  return handler?.(...args);
};

const STEPS = [25, 50, 75];

/** Which of 25/50/75% each play-through crosses, once each; restart() begins the next play-through. */
export function createVideoMilestones() {
  let reached = 0;
  return {
    advance(ratio) {
      const crossed = STEPS.filter((percent) => percent > reached && ratio * 100 >= percent);
      if (crossed.length) reached = crossed[crossed.length - 1];
      return crossed;
    },
    restart() { reached = 0; }
  };
}
