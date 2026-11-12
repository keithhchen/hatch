import { dashboardRequest } from "./data.js";

/** The largest single file the Studio sends to ingest; anything bigger is refused before any request. */
export const MAX_INGEST_BYTES = 50 * 1024 * 1024;
export const tooLarge = file => file.size > MAX_INGEST_BYTES;

const readBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});
const route = (productId, jobId = "") => `/v1/creator/products/${encodeURIComponent(productId)}/ingest${jobId ? `/${encodeURIComponent(jobId)}` : ""}`;

/** The Ingest API as the Studio sees it: one job per file, read back until it settles. */
export function createIngestPort(request = dashboardRequest) {
  return {
    async submit(productId, file, key = crypto.randomUUID()) {
      const item = { name: file.name, content_base64: await readBase64(file), ...(file.type ? { media_type: file.type } : {}) };
      return (await request(route(productId), { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ items: [item] }) })).job;
    },
    async get(productId, jobId) { return (await request(route(productId, jobId))).job; }
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

/** Submits one file under one Idempotency-Key (pass `key` to retry the same submission), then settles its job. `onJob` sees the job as soon as the server has one. */
export async function ingestFile(port, productId, file, onState, { key = crypto.randomUUID(), onJob, ...options } = {}) {
  let job;
  try { job = await port.submit(productId, file, key); } catch (error) { onState({ status: "failed", error: error.message }); return; }
  onJob?.(job);
  await settleJob(port, productId, job, onState, options);
}
