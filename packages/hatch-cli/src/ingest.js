import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { HatchError } from "./errors.js";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

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

// inputs: links and file paths -> API items. A file is uploaded straight to object storage by `upload` and referenced by its upload id.
// Fails before reading or uploading anything if a file is too large.
export async function buildIngestItems(inputs, { cwd = process.cwd(), fs = { stat }, upload } = {}) {
  const entries = await Promise.all(inputs.map(async (input) => {
    if (isUrl(input)) return { input };
    const path = resolve(cwd, input);
    let info;
    try { info = await fs.stat(path); } catch { throw new HatchError(`File not found: ${input}`, { code: "file_not_found" }); }
    if (!info.isFile()) throw new HatchError(`Not a file: ${input}`, { code: "not_a_file" });
    if (info.size > MAX_FILE_BYTES) throw new HatchError(`${input} is ${(info.size / 1048576).toFixed(1)} MB, over the ${MAX_FILE_BYTES / 1048576} MB limit per file.`, { code: "too_large" });
    return { input, path, name: basename(path), media_type: guessMediaType(path) };
  }));
  return Promise.all(entries.map(async (e) => e.path ? await upload(e) : { url: e.input }));
}

// Asks the Registry for an upload slot, then PUTs the file to the URL it issued with exactly the headers it issued.
export const uploader = ({ client, fetch = globalThis.fetch, baseUrl, route, readBytes = readFile }) => async ({ path, name, media_type }) => {
  const bytes = await readBytes(path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const slot = await client.post(route, { name, bytes: bytes.length, sha256: digest, media_type });
  const target = slot.url.startsWith("/") ? baseUrl.replace(/\/+$/, "") + slot.url : slot.url;
  let response;
  try { response = await fetch(target, { method: slot.method ?? "PUT", headers: slot.headers, body: bytes }); }
  catch (error) { throw new HatchError(`Upload of ${name} failed: ${error.cause?.code ?? error.message}`, { code: "upload_failed" }); }
  if (!response.ok) throw new HatchError(`Upload of ${name} failed (${response.status})`, { code: "upload_failed", status: response.status });
  return { upload_id: slot.upload_id, name, bytes: bytes.length, sha256: digest, ...(media_type ? { media_type } : {}) };
};

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
