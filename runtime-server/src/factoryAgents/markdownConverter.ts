import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const direct = new Set([".txt", ".md"]);
export const ACCEPTED_UPLOAD_EXTENSIONS = [".txt", ".md", ".docx", ".pptx", ".xlsx", ".pdf"] as const;
export async function convertUpload(name: string, bytes: Buffer): Promise<{ name: string; bytes: Buffer; mimeType: string }> {
  const extension = path.extname(name).toLowerCase();
  if (!ACCEPTED_UPLOAD_EXTENSIONS.includes(extension as typeof ACCEPTED_UPLOAD_EXTENSIONS[number])) throw new Error(`Unsupported file type: ${extension || "unknown"}`);
  if (direct.has(extension)) return { name, bytes, mimeType: extension === ".md" ? "text/markdown" : "text/plain" };
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-markitdown-"));
  const source = path.join(directory, `${randomUUID()}${extension}`);
  try {
    await writeFile(source, bytes);
    const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../scripts/convert_to_markdown.py");
    const { stdout } = await execFileAsync(process.env.PYTHON_BIN || "python3", [script, source], { timeout: 120_000, maxBuffer: 25 * 1024 * 1024 });
    return { name: `${name.slice(0, -extension.length)}.md`, bytes: Buffer.from(stdout), mimeType: "text/markdown" };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
