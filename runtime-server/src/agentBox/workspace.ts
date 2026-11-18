import path from "node:path";
import { FILE_LIMITS, pageOf } from "../assets/files.js";
import type { PdfPageRenderer } from "../assets/pdfPages.js";
import { decodeText } from "../assets/sniff.js";
import type { ToolOutput } from "../assets/toolOutput.js";
import { BoxFileMissing, BoxToolError, type AgentBox } from "./ports.js";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_VIEW_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MAX_TIMEOUT_SECONDS = 300;
const IMAGES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The Agent's view of its box: files under one working directory, and shell commands run there. Paths are confined to that
 * directory (a relative path starts in it; `..` is refused), so the Agent keeps its work in one place; it is the Agent's own box, so this is
 * a house rule, not a security boundary.
 */
export class Workspace {
  constructor(private readonly box: AgentBox, readonly workDir: string, private readonly pdf: PdfPageRenderer) {}

  /** The absolute path of `raw` inside the working directory. */
  resolve(raw: unknown): string {
    if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) throw new BoxToolError(`path is a file or directory under ${this.workDir} (got ${JSON.stringify(raw)}).`);
    if (raw.split("/").includes("..")) throw new BoxToolError(`Paths stay under ${this.workDir}: ".." is not allowed.`);
    const resolved = path.posix.resolve(this.workDir, raw);
    if (resolved !== this.workDir && !resolved.startsWith(`${this.workDir}/`)) throw new BoxToolError(`Paths stay under ${this.workDir} (got ${raw}).`);
    return resolved;
  }

  async write(args: Record<string, unknown>): Promise<string> {
    const file = this.resolve(args.path);
    if (typeof args.content !== "string") throw new BoxToolError("content is the whole file as a string.");
    const bytes = Buffer.from(args.content, "utf8");
    if (bytes.length > MAX_FILE_BYTES) throw new BoxToolError(`write takes at most ${MAX_FILE_BYTES / 1024 / 1024} MB; write the file in parts with edit, or build it with bash.`);
    await this.box.writeFile(file, bytes);
    return `Wrote ${file} (${bytes.length} bytes).`;
  }

  async edit(args: Record<string, unknown>): Promise<string> {
    const file = this.resolve(args.path);
    const { old_string: oldString, new_string: newString } = args;
    if (typeof oldString !== "string" || !oldString || typeof newString !== "string") throw new BoxToolError("old_string (non-empty) and new_string are strings.");
    const current = (await this.readText(file)).text;
    const count = current.split(oldString).length - 1;
    if (!count) throw new BoxToolError(`old_string was not found in ${file}. Read the file and copy the text exactly.`);
    if (count > 1 && args.replace_all !== true) throw new BoxToolError(`old_string appears ${count} times in ${file}; add surrounding text to make it unique, or set replace_all.`);
    const next = args.replace_all === true ? current.split(oldString).join(newString) : current.replace(oldString, () => newString);
    const bytes = Buffer.from(next, "utf8");
    if (bytes.length > MAX_FILE_BYTES) throw new BoxToolError(`The file would pass ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    await this.box.writeFile(file, bytes);
    return `Edited ${file} (${count > 1 ? `${count} places, ` : ""}${bytes.length} bytes).`;
  }

  /** Text in pages by `offset` (as attachments are read), an image as pixels, a PDF one page at a time (`page`). */
  async read(args: Record<string, unknown>): Promise<ToolOutput> {
    const file = this.resolve(args.path);
    const { offset = 0, page = 1 } = args;
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || typeof page !== "number" || !Number.isInteger(page) || page < 1) throw new BoxToolError("offset and page must be positive integers.");
    const extension = path.posix.extname(file).toLowerCase();
    if (IMAGES[extension] || extension === ".pdf") {
      const bytes = await this.bytes(file, MAX_VIEW_BYTES);
      if (IMAGES[extension]) return { text: `${file} (image)`, image: { mimeType: IMAGES[extension], data: bytes.toString("base64") } };
      const rendered = await this.pdf.render(bytes, page).catch((error: unknown) => { throw new BoxToolError(error instanceof Error ? error.message : String(error)); });
      return { text: `${file}, page ${rendered.page} of ${rendered.pages}${rendered.page < rendered.pages ? `. Call read again with page=${rendered.page + 1} for the next page.` : ""}`, image: { mimeType: "image/png", data: rendered.png.toString("base64") } };
    }
    return JSON.stringify(pageOf(file, (await this.readText(file)).text, offset, FILE_LIMITS.readChars));
  }

  async ls(args: Record<string, unknown>): Promise<string> {
    const target = args.path === undefined ? this.workDir : this.resolve(args.path);
    const listed = await this.box.exec(`ls -lAh --group-directories-first -- ${quote(target)}`, { cwd: this.workDir, timeoutSeconds: 30 });
    if (listed.exitCode !== 0) throw new BoxToolError(listed.stderr.trim() || `${target} cannot be listed.`);
    return listed.stdout || `${target} is empty.`;
  }

  async bash(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (typeof args.command !== "string" || !args.command.trim()) throw new BoxToolError("command is a shell command.");
    const requested = args.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : args.timeout;
    if (typeof requested !== "number" || !(requested > 0)) throw new BoxToolError("timeout is a number of seconds.");
    const timeoutSeconds = Math.min(requested, MAX_TIMEOUT_SECONDS);
    const result = await this.box.exec(args.command, { cwd: this.workDir, timeoutSeconds, ...(signal ? { signal } : {}) });
    return [`exit code: ${result.exitCode}`, ...(result.stdout ? [`stdout:\n${result.stdout}`] : []), ...(result.stderr ? [`stderr:\n${result.stderr}`] : [])].join("\n");
  }

  /** The file's bytes, at most `max` of them. */
  async bytes(file: string, max: number): Promise<Buffer> {
    const bytes = await this.box.readFile(file).catch((error: unknown) => { throw error instanceof BoxFileMissing ? new BoxToolError(error.message) : error; });
    if (bytes.length > max) throw new BoxToolError(`${file} is ${bytes.length} bytes; the most read or edit takes is ${max}. Use bash (head, grep, python) on it.`);
    return bytes;
  }

  private async readText(file: string): Promise<{ text: string }> {
    const text = decodeText(await this.bytes(file, MAX_FILE_BYTES));
    if (text === undefined) throw new BoxToolError(`${file} is not a text file. Use bash to look at it, or read it if it is an image or a PDF.`);
    return { text };
  }
}
