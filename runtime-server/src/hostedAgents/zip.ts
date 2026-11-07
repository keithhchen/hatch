import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { zipSync, type Zippable } from "fflate";

const IGNORED = new Set([".DS_Store", "Thumbs.db", "__MACOSX"]);
/** Built from local fields on purpose: fflate reads them back locally, so the stored time is the same in every timezone. */
const FIXED_TIME = new Date(1980, 0, 1);

async function paths(dir: string, prefix = ""): Promise<string[]> {
  const entries = (await readdir(join(dir, prefix), { withFileTypes: true })).filter(entry => !IGNORED.has(entry.name));
  const nested = await Promise.all(entries.map(async entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? paths(dir, path) : entry.isFile() ? [path] : [];
  }));
  return nested.flat();
}

/** Zips a directory with its files at the root. The same contents always give the same bytes, whatever the mtimes. */
export async function zipDirectory(dir: string): Promise<Buffer> {
  const files: Zippable = {};
  for (const path of (await paths(dir)).sort()) files[path] = [new Uint8Array(await readFile(join(dir, path))), { level: 6, mtime: FIXED_TIME }];
  return Buffer.from(zipSync(files));
}
