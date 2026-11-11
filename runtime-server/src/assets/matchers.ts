import { Worker } from "node:worker_threads";

/** A tool-call mistake the model can read and correct. */
export class FileToolError extends Error {}

/** Returns the indexes of the first `cap` lines that match. */
export type Matcher = (lines: string[], cap: number) => number[] | Promise<number[]>;

export const REGEX_TIMEOUT_MS = 400;

export function fixedMatcher(needle: string, ignoreCase: boolean): Matcher {
  const target = ignoreCase ? needle.toLowerCase() : needle;
  return (lines, cap) => {
    const hits: number[] = [];
    for (let i = 0; i < lines.length && hits.length < cap; i++) if ((ignoreCase ? lines[i]!.toLowerCase() : lines[i]!).includes(target)) hits.push(i);
    return hits;
  };
}

const WORKER = `
const { parentPort, workerData: { source, flags, lines, cap } } = require("node:worker_threads");
const re = new RegExp(source, flags);
const hits = [];
for (let i = 0; i < lines.length && hits.length < cap; i++) if (re.test(lines[i])) hits.push(i);
parentPort.postMessage(hits);
`;

/** At most this many scans run at once; the rest wait their turn without spending their time budget. */
const MAX_WORKERS = 4;
let running = 0;
const waiting: Array<() => void> = [];
const slot = async () => { if (running >= MAX_WORKERS) await new Promise<void>(resolve => waiting.push(resolve)); running++; };
const release = () => { running--; waiting.shift()?.(); };

/**
 * A model-written regex scans in a worker thread, so the event loop never runs it, and the worker is
 * terminated when the time budget ends: catastrophic backtracking costs one thread for 400 ms, nothing else.
 */
export function regexMatcher(source: string, ignoreCase: boolean): Matcher {
  try { new RegExp(source); } catch { throw new FileToolError("Invalid regular expression"); }
  return async (lines, cap) => {
    await slot();
    const worker = new Worker(WORKER, { eval: true, workerData: { source, flags: ignoreCase ? "i" : "", lines, cap } });
    try {
      return await new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new FileToolError("The regular expression took too long; use a simpler pattern")), REGEX_TIMEOUT_MS);
        worker.once("message", hits => { clearTimeout(timer); resolve(hits); });
        worker.once("error", error => { clearTimeout(timer); reject(error); });
      });
    } finally { await worker.terminate(); release(); }
  };
}
