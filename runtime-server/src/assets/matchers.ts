import vm from "node:vm";

/** A tool-call mistake the model can read and correct. */
export class FileToolError extends Error {}

/** Returns the indexes of the first `cap` lines that match. */
export type Matcher = (lines: string[], cap: number) => number[];

export const REGEX_TIMEOUT_MS = 400;

export function fixedMatcher(needle: string, ignoreCase: boolean): Matcher {
  const target = ignoreCase ? needle.toLowerCase() : needle;
  return (lines, cap) => {
    const hits: number[] = [];
    for (let i = 0; i < lines.length && hits.length < cap; i++) if ((ignoreCase ? lines[i]!.toLowerCase() : lines[i]!).includes(target)) hits.push(i);
    return hits;
  };
}

const SCAN = new vm.Script(`(() => { const re = new RegExp(source, flags); const hits = []; for (let i = 0; i < lines.length && hits.length < cap; i++) if (re.test(lines[i])) hits.push(i); return hits; })()`);

/**
 * A model-written regex runs in its own VM context under a hard time limit, so
 * catastrophic backtracking ends the scan with an error instead of the process.
 */
export function regexMatcher(source: string, ignoreCase: boolean): Matcher {
  try { new RegExp(source); } catch { throw new FileToolError("Invalid regular expression"); }
  return (lines, cap) => {
    try {
      return SCAN.runInContext(vm.createContext({ source, flags: ignoreCase ? "i" : "", lines, cap }), { timeout: REGEX_TIMEOUT_MS }) as number[];
    } catch {
      throw new FileToolError("The regular expression took too long; use a simpler pattern");
    }
  };
}
