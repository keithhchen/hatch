import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { HatchError } from "./errors.js";

export const MAX_TOTAL_BYTES = 30 * 1024 * 1024;

const MEDIA_TYPES = {
  ".md": "text/markdown", ".txt": "text/plain", ".html": "text/html", ".htm": "text/html", ".csv": "text/csv",
  ".json": "application/json", ".pdf": "application/pdf", ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".zip": "application/zip"
};

export const guessMediaType = (name) => MEDIA_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";

const isUrl = (input) => /^https?:\/\//i.test(input);

// inputs: links and file paths -> API items. Fails before reading anything if too large.
export async function buildIngestItems(inputs, { cwd = process.cwd(), fs = { readFile, stat } } = {}) {
  const entries = await Promise.all(inputs.map(async (input) => {
    if (isUrl(input)) return { input };
    const path = resolve(cwd, input);
    let info;
    try { info = await fs.stat(path); } catch { throw new HatchError(`File not found: ${input}`, { code: "file_not_found" }); }
    if (!info.isFile()) throw new HatchError(`Not a file: ${input}`, { code: "not_a_file" });
    return { input, path, size: info.size };
  }));
  const total = entries.reduce((sum, e) => sum + (e.size ?? 0), 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new HatchError(`Files total ${(total / 1048576).toFixed(1)} MB, over the ${MAX_TOTAL_BYTES / 1048576} MB limit per ingest. Split them into several ingests.`, { code: "too_large" });
  }
  return Promise.all(entries.map(async (e) => e.path
    ? { name: basename(e.path), content_base64: (await fs.readFile(e.path)).toString("base64"), media_type: guessMediaType(e.path) }
    : { url: e.input }));
}

export const isFinished = (job) => job?.status === "done" || job?.status === "failed";

/** A server hiccup (5xx, network) while polling is not the job's outcome: retry it a few times. */
export const transient = (error) => error?.status === undefined || error.status >= 500;
export const tolerating = (fn, { attempts = 6, sleep, delayMs = 5000, isTransient = transient }) => async (...args) => {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(...args); }
    catch (error) { if (attempt >= attempts || !isTransient(error)) throw error; await sleep(delayMs); }
  }
};

export async function waitForJob(fetchJob, { sleep, intervalMs = 5000, onProgress = () => {} }) {
  const poll = tolerating(fetchJob, { sleep, delayMs: intervalMs });
  for (;;) {
    const job = await poll();
    onProgress(job);
    if (isFinished(job)) return job;
    await sleep(intervalMs);
  }
}
