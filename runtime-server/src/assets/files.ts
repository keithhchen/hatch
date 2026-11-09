import vm from "node:vm";
import type { Asset, AssetBlobs, AssetRepository, AssetScope } from "./domain.js";
import { ATTACHMENTS_ROOT, pathsFor } from "./views.js";

export const FILE_LIMITS = {
  lsEntries: 200, grepFiles: 100, grepScanBytes: 20 * 1024 * 1024, grepMatches: 50, grepMatchesMax: 200, grepContextMax: 5,
  grepOutputChars: 8_000, lineChars: 300, patternChars: 300, regexMsPerFile: 400, grepMs: 3_000, readChars: 8_000, readCharsMax: 20_000
} as const;

/** A tool-call mistake the model can read and correct. */
export class FileToolError extends Error {}

type Entry = { path: string; asset: Asset };
type Segments = string[];

/** Anything outside /attachments, or any odd segment, fails before the index is consulted. */
function segments(path: string): Segments {
  if (typeof path !== "string" || /[\0\\]/.test(path)) throw new FileToolError("Invalid path");
  const parts = path.replace(/\/+$/, "").split("/");
  if (parts[0] !== "" || parts[1] !== ATTACHMENTS_ROOT.slice(1)) throw new FileToolError(`Path must be inside ${ATTACHMENTS_ROOT}`);
  const rest = parts.slice(2);
  if (rest.length > 2 || rest.some(part => !part || part === "." || part === "..")) throw new FileToolError("Invalid path");
  return rest;
}

/**
 * Read-only Unix-style view of one scope's attachments: /attachments/<message_id>/<name>.
 * The index is built from that scope alone, so a path in anyone else's scope does not exist.
 */
export class AttachmentFiles {
  constructor(private readonly repository: AssetRepository, private readonly blobs: AssetBlobs) {}

  private async index(scope: AssetScope): Promise<Map<string, Entry[]>> {
    const byMessage = new Map<string, Asset[]>();
    for (const asset of await this.repository.listAttached(scope)) byMessage.set(asset.messageId!, [...byMessage.get(asset.messageId!) ?? [], asset]);
    return new Map([...byMessage].map(([messageId, assets]) => {
      const paths = pathsFor(messageId, assets);
      return [messageId, assets.map(asset => ({ path: paths.get(asset.id)!, asset }))];
    }));
  }

  private select(index: Map<string, Entry[]>, parts: Segments): Entry[] {
    if (parts.length === 0) return [...index.values()].flat();
    const messageEntries = index.get(parts[0]!);
    if (!messageEntries) throw new FileToolError("No such file or directory");
    if (parts.length === 1) return messageEntries;
    const found = messageEntries.filter(entry => entry.path === `${ATTACHMENTS_ROOT}/${parts.join("/")}`);
    if (!found.length) throw new FileToolError("No such file or directory");
    return found;
  }

  private text(entry: Entry): Promise<string | undefined> {
    const derivative = entry.asset.derivative("text") ?? entry.asset.derivative("transcript");
    return derivative ? this.blobs.get(derivative.key).then(bytes => bytes.toString("utf8")) : Promise.resolve(undefined);
  }

  async ls(scope: AssetScope, path = ATTACHMENTS_ROOT): Promise<string> {
    const parts = segments(path);
    const index = await this.index(scope);
    const lines = parts.length === 0
      ? [...index].map(([messageId, entries]) => `${messageId}/  (${entries.length} files)`)
      : this.select(index, parts).map(({ path: p, asset }) => `${p}  ${asset.record.mime}  ${asset.record.bytes} bytes${asset.derivative("text") || asset.derivative("transcript") ? "" : "  (not text)"}`);
    const shown = lines.slice(0, FILE_LIMITS.lsEntries);
    return [...shown, ...lines.length > shown.length ? [`... ${lines.length - shown.length} more`] : []].join("\n") || "(empty)";
  }

  async read(scope: AssetScope, path: string, offset = 0, limit: number = FILE_LIMITS.readChars): Promise<{ path: string; content: string; offset: number; next_offset: number | null; total_chars: number }> {
    const parts = segments(path);
    if (parts.length !== 2) throw new FileToolError("read needs a file path");
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) throw new FileToolError("offset and limit must be non-negative integers");
    const [entry] = this.select(await this.index(scope), parts);
    const text = await this.text(entry!);
    if (text === undefined) throw new FileToolError("This file has no text form (for example an image)");
    let end = Math.min(text.length, offset + Math.min(limit, FILE_LIMITS.readCharsMax));
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end -= 1;
    return { path: entry!.path, content: text.slice(offset, end), offset, next_offset: end < text.length ? end : null, total_chars: text.length };
  }

  async grep(scope: AssetScope, query: GrepQuery): Promise<string> {
    const { pattern, fixed = false, ignoreCase = false, context = 0, path = ATTACHMENTS_ROOT } = query;
    const maxMatches = Math.min(query.maxMatches ?? FILE_LIMITS.grepMatches, FILE_LIMITS.grepMatchesMax);
    const around = Math.max(0, Math.min(context, FILE_LIMITS.grepContextMax));
    if (!pattern || pattern.length > FILE_LIMITS.patternChars) throw new FileToolError(`Pattern must be 1 to ${FILE_LIMITS.patternChars} characters`);
    const matcher = fixed ? fixedMatcher(pattern, ignoreCase) : regexMatcher(pattern, ignoreCase);
    const entries = this.select(await this.index(scope), segments(path));
    if (entries.length > FILE_LIMITS.grepFiles) throw new FileToolError(`Too many files (${entries.length}); narrow the path`);

    const started = Date.now();
    let scanned = 0;
    let matches = 0;
    const out: string[] = [];
    for (const entry of entries) {
      if (matches >= maxMatches) break;
      if (Date.now() - started > FILE_LIMITS.grepMs) { out.push("[stopped: time limit]"); break; }
      const text = await this.text(entry);
      if (text === undefined) continue;
      scanned += text.length;
      if (scanned > FILE_LIMITS.grepScanBytes) { out.push("[stopped: scan limit]"); break; }
      const lines = text.split("\n");
      const hits = matcher(lines.map(line => line.slice(0, FILE_LIMITS.lineChars * 10)), maxMatches - matches);
      matches += hits.length;
      const show = new Set<number>();
      for (const hit of hits) for (let i = Math.max(0, hit - around); i <= Math.min(lines.length - 1, hit + around); i++) show.add(i);
      let previous = -2;
      for (const i of [...show].sort((a, b) => a - b)) {
        if (around && previous >= 0 && i > previous + 1) out.push("--");
        out.push(`${entry.path}${hits.includes(i) ? ":" : "-"}${i + 1}${hits.includes(i) ? ":" : "-"} ${lines[i]!.slice(0, FILE_LIMITS.lineChars)}`);
        previous = i;
      }
    }
    return clip(out.length ? out.join("\n") : "No matches", FILE_LIMITS.grepOutputChars);
  }
}

export type GrepQuery = { pattern: string; fixed?: boolean; ignoreCase?: boolean; context?: number; maxMatches?: number; path?: string };
type Matcher = (lines: string[], cap: number) => number[];

const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max)}\n[output truncated]`;

function fixedMatcher(needle: string, ignoreCase: boolean): Matcher {
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
function regexMatcher(source: string, ignoreCase: boolean): Matcher {
  try { new RegExp(source); } catch { throw new FileToolError("Invalid regular expression"); }
  return (lines, cap) => {
    try {
      return SCAN.runInContext(vm.createContext({ source, flags: ignoreCase ? "i" : "", lines, cap }), { timeout: FILE_LIMITS.regexMsPerFile }) as number[];
    } catch {
      throw new FileToolError("The regular expression took too long; use a simpler pattern or fixed=true");
    }
  };
}
