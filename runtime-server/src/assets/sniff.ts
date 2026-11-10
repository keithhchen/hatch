import { unzipSync } from "fflate";
import { AssetError, type AssetKind } from "./domain.js";

export type Sniffed = { kind: AssetKind; mime: string; ext: string };

export const ZIP_LIMITS = { entries: 2_000, uncompressedBytes: 200 * 1024 * 1024, ratio: 200 };

const startsWith = (b: Buffer, hex: string, at = 0) => b.subarray(at, at + hex.length / 2).toString("hex") === hex;
const ascii = (b: Buffer, at: number, length: number) => b.subarray(at, at + length).toString("latin1");

/** Declared sizes are checked before anything inflates; the filter never selects an entry, so nothing inflates here. */
function sniffOffice(bytes: Buffer): Sniffed | undefined {
  const names: string[] = [];
  let total = 0;
  try {
    unzipSync(bytes, { filter: file => {
      names.push(file.name); total += file.originalSize;
      if (names.length > ZIP_LIMITS.entries || total > ZIP_LIMITS.uncompressedBytes || total > bytes.length * ZIP_LIMITS.ratio) {
        throw new AssetError("unsafe_archive", "Archive is too large or too compressed");
      }
      return false;
    } });
  } catch (error) {
    if (error instanceof AssetError) throw error;
    throw new AssetError("malformed", "Unreadable archive");
  }
  const has = (prefix: string) => names.some(name => name.startsWith(prefix));
  if (has("word/")) return { kind: "file", ext: ".docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  if (has("ppt/")) return { kind: "file", ext: ".pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
  if (has("xl/")) return { kind: "file", ext: ".xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  return undefined;
}

/** Text means valid UTF-8 or GB18030 with no NUL bytes. */
export const decodeText = (bytes: Buffer): string | undefined => {
  if (bytes.subarray(0, 8192).includes(0)) return undefined;
  for (const label of ["utf-8", "gb18030"]) {
    try { return new TextDecoder(label, { fatal: true }).decode(bytes).replace(/^﻿/, ""); } catch { /* try the next */ }
  }
  return undefined;
};

const TEXT_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown", ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".json": "application/json",
  ".yaml": "application/yaml", ".yml": "application/yaml", ".xml": "application/xml", ".html": "text/html", ".log": "text/plain"
};

/**
 * The content decides, never the extension. The name is consulted only to label
 * text formats, which have no signature.
 */
export function sniff(bytes: Buffer, name: string): Sniffed {
  if (startsWith(bytes, "89504e470d0a1a0a")) return { kind: "image", mime: "image/png", ext: ".png" };
  if (startsWith(bytes, "ffd8ff")) return { kind: "image", mime: "image/jpeg", ext: ".jpg" };
  if (ascii(bytes, 0, 3) === "GIF") return { kind: "image", mime: "image/gif", ext: ".gif" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return { kind: "image", mime: "image/webp", ext: ".webp" };
  if (ascii(bytes, 0, 5) === "%PDF-") return { kind: "file", mime: "application/pdf", ext: ".pdf" };
  if (startsWith(bytes, "504b0304")) {
    const office = sniffOffice(bytes);
    if (office) return office;
    throw new AssetError("unsupported_type", "Unsupported archive");
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return { kind: "audio", mime: "audio/wav", ext: ".wav" };
  if (ascii(bytes, 0, 4) === "OggS") return { kind: "audio", mime: "audio/ogg", ext: ".ogg" };
  // ADTS AAC: a 12-bit sync word, then layer bits 00 (MP3 has them set).
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0) return { kind: "audio", mime: "audio/aac", ext: ".aac" };
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return { kind: "audio", mime: "audio/mpeg", ext: ".mp3" };
  if (ascii(bytes, 4, 4) === "ftyp") return { kind: "audio", mime: "audio/mp4", ext: ".m4a" };
  if (startsWith(bytes, "1a45dfa3")) return { kind: "audio", mime: "audio/webm", ext: ".webm" };
  if (ascii(bytes, 0, 5) === "#!AMR") return { kind: "audio", mime: "audio/amr", ext: ".amr" };
  if (ascii(bytes, 0, 4) === "caff") return { kind: "audio", mime: "audio/x-caf", ext: ".caf" };
  // WeChat's SILK may start with one 0x02 byte before the signature. ffmpeg cannot decode it, but it is a voice message and is refused as one.
  if (ascii(bytes, 0, 9) === "#!SILK_V3" || ascii(bytes, 1, 9) === "#!SILK_V3") return { kind: "audio", mime: "audio/silk", ext: ".silk" };
  if (decodeText(bytes) !== undefined) {
    const extension = /\.[^./\\]+$/.exec(name)?.[0]?.toLowerCase() ?? "";
    return { kind: "file", ext: TEXT_BY_EXTENSION[extension] ? extension : ".txt", mime: TEXT_BY_EXTENSION[extension] ?? "text/plain" };
  }
  throw new AssetError("unsupported_type", "Unsupported file type");
}
