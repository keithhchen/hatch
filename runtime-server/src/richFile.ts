import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

export const MAX_RICH_DOCUMENT_TEXT_CHARS = 200_000;

const PDF_MEDIA_TYPE = "application/pdf";
const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * Convert a local-runner binary file result into a bounded model-readable
 * projection. The original base64 remains ephemeral on this return value and
 * is removed by modelVisibleToolResult before it reaches the transcript/UI.
 */
export async function normalizeRichFileReadResult(result: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (result.content_type !== "document" || typeof result.data_base64 !== "string") return result;

  const bytes = decodeBase64(result.data_base64);
  const displayName = typeof result.path === "string" ? path.basename(result.path) : "document";
  const mediaType = typeof result.mime_type === "string" ? result.mime_type : "";
  try {
    const extracted = await extractRichDocument(displayName, mediaType, bytes);
    const bounded = boundRichDocumentText(extracted.content);
    return {
      ...result,
      content: bounded.content,
      extraction: {
        format: extracted.format,
        truncated: bounded.truncated
      }
    };
  } catch (error) {
    return {
      ...result,
      extraction: {
        format: documentFormat(displayName, mediaType),
        status: "unavailable",
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export async function extractRichDocument(
  displayName: string,
  mediaType: string,
  bytes: Buffer
): Promise<{ format: string; content: string }> {
  const extension = path.extname(displayName).toLowerCase();
  if (mediaType === PDF_MEDIA_TYPE || extension === ".pdf") {
    return { format: "pdf", content: await pdfToText(bytes) };
  }
  if (mediaType === DOCX_MEDIA_TYPE || extension === ".docx") {
    return { format: "docx", content: htmlToPlainText((await mammoth.convertToHtml({ buffer: bytes })).value) };
  }
  if (mediaType === XLSX_MEDIA_TYPE || mediaType === "application/vnd.ms-excel" || extension === ".xlsx" || extension === ".xls") {
    return { format: extension === ".xls" || mediaType === "application/vnd.ms-excel" ? "xls" : "xlsx", content: workbookToText(bytes, displayName) };
  }
  if (mediaType === PPTX_MEDIA_TYPE || extension === ".pptx") {
    return { format: "pptx", content: presentationToText(bytes, displayName) };
  }
  throw new Error(`No built-in text projection for ${mediaType || extension || "this document"}`);
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("document payload is not valid base64");
  }
  return Buffer.from(value, "base64");
}

async function pdfToText(bytes: Buffer): Promise<string> {
  // pdf-parse's text-only API can load pdf.js in Node environments without a
  // DOM. Supplying the small affine surface keeps PDF reading independent of
  // an optional canvas/native rendering dependency.
  const globalScope = globalThis as typeof globalThis & { DOMMatrix?: unknown };
  if (!globalScope.DOMMatrix) Object.defineProperty(globalThis, "DOMMatrix", {
    configurable: true,
    writable: true,
    value: TextOnlyDOMMatrix
  });
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText();
    const pages = String(result.text ?? "")
      .split(/\f/g)
      .map((page) => page.trim())
      .filter(Boolean);
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

function workbookToText(bytes: Buffer, displayName: string): string {
  const workbook = XLSX.read(bytes, { type: "buffer", cellDates: true });
  return [`# ${path.basename(displayName, path.extname(displayName))}`, "", ...workbook.SheetNames.flatMap((name) => {
    const sheet = workbook.Sheets[name]!;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
    return [`## Sheet: ${name}`, "", tableText(rows), ""];
  })].join("\n");
}

function tableText(rows: unknown[][]): string {
  if (rows.length === 0) return "(empty sheet)";
  return rows.map((row) => row.map((cell) => String(cell ?? "")).join("\t")).join("\n");
}

function presentationToText(bytes: Buffer, displayName: string): string {
  const archive = unzipSync(bytes);
  const slideNames = Object.keys(archive)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
  const slides = slideNames.map((name, index) => {
    const xml = strFromU8(archive[name]!);
    const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeXml(match[1] ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
    return `## Slide ${index + 1}\n\n${text || "[No text]"}`;
  });
  return [`# ${path.basename(displayName, path.extname(displayName))}`, "", ...slides].join("\n\n");
}

function slideNumber(value: string): number {
  return Number(value.match(/slide(\d+)\.xml$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function htmlToPlainText(html: string): string {
  return decodeXml(html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_match, body) => `\n\n${stripTags(body)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, body) => `\n- ${stripTags(body)}`)
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_match, body) => `\n${[...body.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((item) => stripTags(item[1] ?? "")).join("\t")}`)
    .replace(/<p[^>]*>|<div[^>]*>|<br\s*\/?\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

function stripTags(value: string): string {
  return decodeXml(value.replace(/<[^>]+>/g, "").trim());
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi, (entity) => ({
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&apos;": "'",
      "&nbsp;": " "
    }[entity.toLowerCase()] ?? entity));
}

export function boundRichDocumentText(
  value: string,
  maxChars = MAX_RICH_DOCUMENT_TEXT_CHARS
): { content: string; truncated: boolean } {
  if (value.length <= maxChars) return { content: value, truncated: false };
  return {
    content: `${value.slice(0, maxChars)}\n[document text truncated]`,
    truncated: true
  };
}

function documentFormat(displayName: string, mediaType: string): string {
  if (mediaType === PDF_MEDIA_TYPE || path.extname(displayName).toLowerCase() === ".pdf") return "pdf";
  if (mediaType === DOCX_MEDIA_TYPE || path.extname(displayName).toLowerCase() === ".docx") return "docx";
  if (mediaType === XLSX_MEDIA_TYPE || path.extname(displayName).toLowerCase() === ".xlsx") return "xlsx";
  if (mediaType === PPTX_MEDIA_TYPE || path.extname(displayName).toLowerCase() === ".pptx") return "pptx";
  return path.extname(displayName).toLowerCase().replace(/^\./, "") || "document";
}
