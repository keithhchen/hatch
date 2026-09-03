import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { documentSkillNameForAsset, skillsRoot } from "./skills.js";

const execFileAsync = promisify(execFile);
export const MAX_RICH_DOCUMENT_TEXT_CHARS = 200_000;

/**
 * Convert a local-runner binary file result into a bounded model-readable
 * projection. The original base64 remains ephemeral on this return value and
 * is removed by modelVisibleToolResult before it reaches the transcript/UI.
 *
 * The projection is deliberately delegated to the owning document Skill's
 * reader entrypoint. This adapter only stages immutable bytes in a private
 * temporary directory, invokes the Skill, and validates its JSON envelope; it
 * is not a second document parser.
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

/**
 * Read one document through the Skill-owned `scripts/read_asset.mjs` reader.
 * `skillDirectory` is supplied for the session-selected Skill; callers that
 * do not have a catalog record use the bundled runtime Skill root.
 */
export async function extractRichDocument(
  displayName: string,
  mediaType: string,
  bytes: Buffer,
  skillDirectory?: string
): Promise<{ format: string; content: string }> {
  const skillName = documentSkillNameForAsset(displayName, mediaType);
  if (!skillName) {
    throw new Error(`No built-in text projection for ${mediaType || path.extname(displayName) || "this document"}`);
  }

  const extension = assetExtension(displayName, mediaType);
  if (skillName === "documents" && ![".docx", ".dotx", ".docm", ".dotm"].includes(extension)) {
    throw new Error(`No built-in text projection for ${mediaType || extension || "this document"}`);
  }
  if (skillName === "presentations" && ![".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm"].includes(extension)) {
    throw new Error(`No built-in text projection for ${mediaType || extension || "this document"}`);
  }

  const directory = path.resolve(skillDirectory || path.join(skillsRoot(), skillName));
  const reader = path.join(directory, "scripts", "read_asset.mjs");
  const stagedRoot = await mkdtemp(path.join(os.tmpdir(), "hatch-skill-asset-"));
  const stagedInput = path.join(stagedRoot, `asset${assetExtension(displayName, mediaType)}`);
  try {
    await writeFile(stagedInput, bytes, { mode: 0o600, flag: "wx" });
    const result = await runSkillReader(reader, stagedInput, directory);
    if (!result || result.status !== "ok" || typeof result.content !== "string") {
      throw new Error("Skill reader returned an invalid projection envelope");
    }
    return {
      format: typeof result.format === "string" ? result.format : skillName,
      content: result.content
    };
  } finally {
    await rm(stagedRoot, { recursive: true, force: true });
  }
}

async function runSkillReader(
  reader: string,
  input: string,
  skillDirectory: string
): Promise<Record<string, unknown>> {
  try {
    const result = await execFileAsync(process.execPath, [
      reader,
      "--input",
      input,
      "--max-chars",
      String(MAX_RICH_DOCUMENT_TEXT_CHARS)
    ], {
      cwd: skillDirectory,
      env: { ...process.env },
      maxBuffer: 4 * 1024 * 1024
    });
    return parseReaderEnvelope(result.stdout);
  } catch (error) {
    const stdout = typeof error === "object" && error !== null && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "")
      : "";
    let envelope: Record<string, unknown> | undefined;
    try {
      envelope = parseReaderEnvelope(stdout);
    } catch {
      envelope = undefined;
    }
    if (typeof envelope?.message === "string") throw new Error(envelope.message);
    const detail = [
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : "",
      error instanceof Error ? error.message : String(error)
    ].filter(Boolean).join("\n");
    throw new Error(`Skill reader unavailable: ${detail}`);
  }
}

function parseReaderEnvelope(stdout: string): Record<string, unknown> {
  const text = stdout.trim();
  if (!text) throw new Error("Skill reader returned no JSON");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const parsed = JSON.parse(lines.at(-1) ?? text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Skill reader returned a non-object JSON envelope");
  }
  return parsed as Record<string, unknown>;
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("document payload is not valid base64");
  }
  return Buffer.from(value, "base64");
}

function assetExtension(displayName: string, mediaType: string): string {
  const extension = path.extname(displayName).toLowerCase();
  const supportedExtensions = new Set([
    ".pdf",
    ".doc", ".docx", ".docm", ".dot", ".dotx", ".dotm", ".rtf",
    ".xls", ".xlsx", ".xlsm", ".xltx", ".xltm", ".csv", ".tsv",
    ".ppt", ".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm"
  ]);
  if (supportedExtensions.has(extension)) return extension;
  const normalized = mediaType.toLowerCase().split(";", 1)[0];
  return ({
    "application/pdf": ".pdf",
    "application/msword": ".doc",
    "application/rtf": ".rtf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template": ".dotx",
    "application/vnd.ms-word.document.macroenabled.12": ".docm",
    "application/vnd.ms-word.template.macroenabled.12": ".dotm",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.template": ".xltx",
    "application/vnd.ms-excel.sheet.macroenabled.12": ".xlsm",
    "application/vnd.ms-excel.template.macroenabled.12": ".xltm",
    "text/csv": ".csv",
    "text/tab-separated-values": ".tsv",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.template": ".potx",
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow": ".ppsx",
    "application/vnd.ms-powerpoint.presentation.macroenabled.12": ".pptm",
    "application/vnd.ms-powerpoint.template.macroenabled.12": ".potm",
    "application/vnd.ms-powerpoint.slideshow.macroenabled.12": ".ppsm"
  } as Record<string, string>)[normalized] ?? "";
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
  const skill = documentSkillNameForAsset(displayName, mediaType);
  if (skill === "pdf") return "pdf";
  if (skill === "documents") return path.extname(displayName).toLowerCase().replace(/^\./, "") || "docx";
  if (skill === "spreadsheets") return path.extname(displayName).toLowerCase().replace(/^\./, "") || "xlsx";
  if (skill === "presentations") return path.extname(displayName).toLowerCase().replace(/^\./, "") || "pptx";
  return path.extname(displayName).toLowerCase().replace(/^\./, "") || "document";
}
