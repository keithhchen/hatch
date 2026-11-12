import { dashboardRequest } from "./data.js";

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
    async submit(productId, file) {
      const item = { name: file.name, content_base64: await readBase64(file), ...(file.type ? { media_type: file.type } : {}) };
      return (await request(route(productId), { method: "POST", body: JSON.stringify({ items: [item] }) })).job;
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

/** Submits one file and reports each real state change through `onState`; failures arrive as `failed` with the server's message. */
export async function ingestFile(port, productId, file, onState, { wait = pause, interval = 1500 } = {}) {
  try {
    let job = await port.submit(productId, file);
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
