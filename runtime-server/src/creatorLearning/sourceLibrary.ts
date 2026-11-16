import { createHash } from "node:crypto";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import type { SourceProjection } from "./types.js";

const SAFE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export class CreatorSourceLibraryError extends Error {
  constructor(
    readonly code:
      | "source_not_found"
      | "snapshot_not_found"
      | "creator_mismatch"
      | "invalid_source"
      | "invalid_snapshot"
      | "projection_failed",
    message: string
  ) {
    super(message);
    this.name = "CreatorSourceLibraryError";
  }
}

export async function projectSource(displayName: string, mediaType: string, bytes: Buffer): Promise<SourceProjection> {
  if (SAFE_IMAGE_TYPES.has(mediaType)) {
    assertImageMagic(mediaType, bytes);
    return { kind: "image", mediaType: mediaType as "image/jpeg" | "image/png" | "image/webp", contentRef: "", sha256: digestBytes(bytes), bytes: bytes.length };
  }
  let markdown: string;
  try {
    const extension = path.extname(displayName).toLowerCase();
    if (mediaType === "application/pdf" || extension === ".pdf") markdown = await pdfToMarkdown(bytes);
    else if (mediaType.includes("wordprocessingml") || extension === ".docx") markdown = await docxToMarkdown(bytes);
    else if (mediaType.includes("spreadsheet") || extension === ".xlsx" || extension === ".xls" || extension === ".xlsm") markdown = workbookToMarkdown(bytes, displayName);
    else if (mediaType.includes("presentationml") || extension === ".pptx") markdown = presentationToMarkdown(bytes, displayName);
    else if (mediaType === "text/csv" || extension === ".csv" || extension === ".tsv") markdown = delimitedToMarkdown(bytes.toString("utf8"), extension === ".tsv" ? "\t" : ",", displayName);
    else if (mediaType === "text/html" || extension === ".html" || extension === ".htm") markdown = htmlToMarkdown(bytes.toString("utf8"));
    else if (mediaType === "application/json" || extension === ".json") markdown = jsonToMarkdown(bytes.toString("utf8"));
    else markdown = normalizeMarkdown(decodeText(bytes));
  } catch (error) {
    if (error instanceof CreatorSourceLibraryError) throw error;
    throw new CreatorSourceLibraryError("projection_failed", `Could not project ${displayName}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const content = normalizeMarkdown(markdown);
  if (!content.trim()) throw invalidSource(`${displayName} produced an empty Markdown projection`);
  return { kind: "markdown", mediaType: "text/markdown", contentRef: "", sha256: digestText(content), bytes: Buffer.byteLength(content, "utf8"), __content: content } as SourceProjection & { __content: string };
}


// The projection content is carried through a private symbol-like field while
// creating the metadata record; this helper is replaced by the caller below.

async function pdfToMarkdown(bytes: Buffer): Promise<string> {
  // pdf-parse uses pdf.js' text layer, not its renderer. Some Node images do
  // not ship the optional native canvas binding; pdf.js still evaluates a
  // DOMMatrix at module load in that case. Provide the tiny affine surface
  // needed by the text-only path so PDF upload does not depend on canvas.
  const globalScope = globalThis as typeof globalThis & { DOMMatrix?: unknown };
  // Where the canvas binding exists, use its real DOMMatrix: pdf.js decides at load, and report mode renders pages in this process.
  if (!globalScope.DOMMatrix) Object.defineProperty(globalThis, "DOMMatrix", {
    configurable: true,
    writable: true,
    value: (await import("@napi-rs/canvas").catch(() => undefined))?.DOMMatrix ?? TextOnlyDOMMatrix
  });
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText();
    const pages = String(result.text ?? "").split(/\f/g).map((page) => page.trim()).filter(Boolean);
    return pages.map((page, index) => `## Page ${index + 1}\n\n${page}`).join("\n\n");
  } finally {
    await parser.destroy();
  }
}

class TextOnlyDOMMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(value?: unknown) {
    if (Array.isArray(value) && value.length >= 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = value.slice(0, 6).map(Number) as [number, number, number, number, number, number];
    }
  }

  multiply(): this { return this; }
  multiplySelf(): this { return this; }
  preMultiplySelf(): this { return this; }
  translate(): this { return this; }
  scale(): this { return this; }
  invertSelf(): this { return this; }
}

async function docxToMarkdown(bytes: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer: bytes });
  return htmlToMarkdown(result.value);
}

function workbookToMarkdown(bytes: Buffer, displayName: string): string {
  const workbook = XLSX.read(bytes, { type: "buffer", cellDates: true });
  return [`# ${path.basename(displayName, path.extname(displayName))}`, "", ...workbook.SheetNames.flatMap((name) => {
    const sheet = workbook.Sheets[name]!;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
    return [`## Sheet: ${name}`, "", tableMarkdown(rows), ""];
  })].join("\n");
}

function presentationToMarkdown(bytes: Buffer, displayName: string): string {
  const archive = unzipSync(bytes);
  const slideNames = Object.keys(archive)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
  const slides = slideNames.map((name, index) => {
    const xml = strFromU8(archive[name]!);
    const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeHtml(match[1] ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
    return `## Slide ${index + 1}\n\n${text || "[No text]"}`;
  });
  return [`# ${path.basename(displayName, path.extname(displayName))}`, "", ...slides].join("\n\n");
}

function slideNumber(value: string): number {
  return Number(value.match(/slide(\d+)\.xml$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function delimitedToMarkdown(text: string, delimiter: string, displayName: string): string {
  const rows = parseDelimited(text, delimiter);
  return [`# ${path.basename(displayName, path.extname(displayName))}`, "", tableMarkdown(rows)].join("\n");
}

function tableMarkdown(rows: unknown[][]): string {
  const normalized = rows.map((row) => row.map((cell) => String(cell ?? "").replaceAll("|", "\\|")));
  if (!normalized.length) return "| |\n|---|";
  const width = Math.max(1, ...normalized.map((row) => row.length));
  const padded = normalized.map((row) => [...row, ...Array.from({ length: width - row.length }, () => "")]);
  const header = padded[0]!;
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...padded.slice(1).map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

function htmlToMarkdown(html: string): string {
  let value = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "");
  value = value
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, body) => `${"#".repeat(Number(level))} ${stripTags(body)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, body) => `- ${stripTags(body)}\n`)
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m, body) => `| ${[...body.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => stripTags(match[1]!)).join(" | ")} |\n`)
    .replace(/<p[^>]*>|<div[^>]*>|<br\s*\/?\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  return decodeHtml(value);
}

function jsonToMarkdown(text: string): string {
  const parsed = JSON.parse(text) as unknown;
  return `# JSON source\n\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
}

function normalizeMarkdown(text: string): string {
  return decodeHtml(text).replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim() + "\n";
}

function decodeText(bytes: Buffer): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') { cell += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === delimiter) { row.push(cell); cell = ""; continue; }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell); rows.push(row); row = []; cell = ""; continue;
    }
    cell += char;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, "").trim());
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " }[entity.toLowerCase()] ?? entity));
}

export function detectMediaType(displayName: string, supplied: string | undefined, bytes: Buffer): string {
  if (supplied?.trim()) return supplied.split(";", 1)[0]!.trim().toLowerCase();
  const extension = path.extname(displayName).toLowerCase();
  const byExtension: Record<string, string> = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".json": "application/json",
    ".html": "text/html",
    ".htm": "text/html",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".tif": "image/tiff",
    ".tiff": "image/tiff"
  };
  if (bytes.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return byExtension[extension] ?? "text/plain";
}

function assertImageMagic(mediaType: string, bytes: Buffer): void {
  const valid = mediaType === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mediaType === "image/jpeg"
      ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) throw invalidSource(`Image bytes do not match declared ${mediaType}`);
}






function digestBytes(value: Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function digestText(value: string): string { return digestBytes(Buffer.from(value, "utf8")); }
function invalidSource(message: string): CreatorSourceLibraryError { return new CreatorSourceLibraryError("invalid_source", message); }

