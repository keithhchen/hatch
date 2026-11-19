import { sleep } from "../agentBox/retry.js";

/** How recorded durations become waits. `speed` 2 plays the recording twice as fast; tests inject a `sleep` that returns at once. */
export type ReplayTiming = { speed: number; sleep(ms: number, signal?: AbortSignal): Promise<void> };

export const realTiming = (speed = 1): ReplayTiming => ({ speed, sleep });

/** Waits the recorded duration, divided by the speed factor. */
export const waitRecorded = (timing: ReplayTiming, recordedMs: number, signal?: AbortSignal): Promise<void> => {
  if (!(timing.speed > 0)) throw new Error("load_test_replay speed must be greater than 0");
  return timing.sleep(recordedMs / timing.speed, signal);
};
