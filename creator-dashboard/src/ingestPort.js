import { dashboardRequest } from "./data.js";

/** The largest single file the Studio sends to ingest; anything bigger is refused before any request. */
export const MAX_INGEST_BYTES = 50 * 1024 * 1024;
export const tooLarge = file => file.size > MAX_INGEST_BYTES;

const route = (productId, tail = "") => `/v1/creator/products/${encodeURIComponent(productId)}/ingest${tail}`;
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

/** Why a file did not reach storage. `code` is what the Studio words for the Expert. */
const uploadError = (code, message) => Object.assign(new Error(message), { code });

const sha256Hex = async file => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, "0")).join("");

/** PUTs the raw file to the issued URL with exactly the issued headers, reporting progress as a fraction. */
export const xhrPut = (url, file, headers, { onProgress, signal, timeoutMs = UPLOAD_TIMEOUT_MS } = {}) => new Promise((resolve, reject) => {
  const xhr = new XMLHttpRequest();
  xhr.open("PUT", url);
  for (const [name, value] of Object.entries(headers ?? {})) xhr.setRequestHeader(name, value);
  xhr.timeout = timeoutMs;
  xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded / event.total); };
  xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(uploadError("upload_failed", `Storage answered ${xhr.status}`));
  xhr.onerror = () => reject(uploadError("upload_failed", "Network error"));
  xhr.ontimeout = () => reject(uploadError("upload_timeout", "Upload timed out"));
  xhr.onabort = () => reject(uploadError("upload_aborted", "Upload cancelled"));
  signal?.addEventListener("abort", () => xhr.abort(), { once: true });
  xhr.send(file);
});

/** The Ingest API as the Studio sees it: a file goes straight to object storage, then one job per upload is read back until it settles. */
export function createIngestPort(request = dashboardRequest, put = xhrPut) {
  return {
    /** Asks for an upload slot, puts the file there, and returns the item the job names it by. */
    async upload(productId, file, { onProgress, signal } = {}) {
      const facts = { name: file.name, bytes: file.size, sha256: await sha256Hex(file), ...(file.type ? { media_type: file.type } : {}) };
      const { upload_id, url, headers } = await request(route(productId, "/uploads"), { method: "POST", body: JSON.stringify(facts) });
      await put(url, file, headers, { onProgress, signal });
      return { upload_id, ...facts };
    },
    async submit(productId, item, key = crypto.randomUUID()) {
      return (await request(route(productId), { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ items: [item] }) })).job;
    },
    async get(productId, jobId) { return (await request(route(productId, `/${encodeURIComponent(jobId)}`))).job; }
  };
}

/** What the server says happened to the file, never more. */
export function ingestOutcome(job) {
  const item = job.items?.[0];
  if (item?.status === "ok") return { status: "completed" };
  if (item?.status === "partial") return { status: "partial", error: item.error ?? "" };
  return { status: "failed", error: item?.error || job.error || "" };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** In-flight job ids per product, kept in sessionStorage so a refresh can pick them back up. Storage failures only cost the resume. */
export function createJobStore(productId, storage = globalThis.sessionStorage) {
  const name = `ingest-jobs:${productId}`;
  const read = () => { try { return JSON.parse(storage.getItem(name)) ?? []; } catch { return []; } };
  const write = jobs => { try { storage.setItem(name, JSON.stringify(jobs)); } catch { /* resume is best effort */ } };
  return {
    list: read,
    add: (jobId, fileName) => write([...read().filter(entry => entry.jobId !== jobId), { jobId, name: fileName }]),
    remove: jobId => write(read().filter(entry => entry.jobId !== jobId))
  };
}

/** Reads a job until it settles and reports each real state change through `onState`; failures arrive as `failed` with the server's message. */
export async function settleJob(port, productId, job, onState, { wait = pause, interval = 1500 } = {}) {
  try {
    while (job.status === "queued" || job.status === "running") {
      onState({ status: "ingesting" });
      await wait(interval);
      job = await port.get(productId, job.id);
    }
    onState(ingestOutcome(job));
  } catch (error) {
    onState({ status: "failed", error: error.message });
  }
}

/** What the Expert is told when a request or an upload fails: file-size refusals are "unsupported", the rest keep their code. */
export const failure = error => error.status === 413 || error.code === "file_too_large" ? { status: "unsupported" }
  : error.status === 415 || error.code === "unsupported_media_type" ? { status: "failed", code: "unsupported_media_type" }
  : { status: "failed", error: error.message, ...(error.code ? { code: error.code } : {}) };

/**
 * Uploads one file to storage (reporting progress), then submits it under one Idempotency-Key and settles its job.
 * An upload that failed made no job, so retrying the file starts over with a new upload and a new key; `key` is for
 * repeating a submit whose upload already succeeded. `onJob` sees the job as soon as the server has one.
 */
export async function ingestFile(port, productId, file, onState, { key = crypto.randomUUID(), onJob, onProgress, signal, ...options } = {}) {
  let job;
  try {
    onState({ status: "uploading", progress: 0 });
    const item = await port.upload(productId, file, { signal, onProgress: progress => { onProgress?.(progress); onState({ status: "uploading", progress }); } });
    job = await port.submit(productId, item, key);
  } catch (error) { onState(failure(error)); return; }
  onJob?.(job);
  await settleJob(port, productId, job, onState, options);
}
