/** Domain: an ingest job and its legal transitions. Pure functions; nothing here touches I/O. */

export type IngestInput = { url: string } | { name: string; media_type?: string; bytes: number };
export type ItemStatus = "pending" | "ok" | "partial" | "failed";
export type JobStatus = "queued" | "running" | "done" | "failed";

export type IngestItem = {
  id: string;
  input: IngestInput;
  status: ItemStatus;
  markdown_path?: string;
  original_ref?: string;
  error?: string;
};

export type IngestJob = {
  id: string;
  accountId: string;
  productId: string;
  status: JobStatus;
  context: string;
  items: IngestItem[];
  error?: string;
  createdAt: string;
  updatedAt: string;
};

/** What the item looks like once settled: everything but the id and input. */
export type ItemOutcome = Pick<IngestItem, "status" | "markdown_path" | "original_ref" | "error">;

const ALLOWED: Record<JobStatus, JobStatus[]> = { queued: ["running", "failed"], running: ["done", "failed"], done: [], failed: [] };

const move = (job: IngestJob, to: JobStatus, now: string, change: Partial<IngestJob> = {}): IngestJob => {
  if (!ALLOWED[job.status].includes(to)) throw new Error(`An ingest job cannot go from ${job.status} to ${to}`);
  return { ...job, ...change, status: to, updatedAt: now };
};

export const queuedJob = (id: string, accountId: string, productId: string, inputs: IngestInput[], context: string, now: string): IngestJob => ({
  id, accountId, productId, status: "queued", context, createdAt: now, updatedAt: now,
  items: inputs.map((input, index) => ({ id: `i${index + 1}`, input, status: "pending" })),
});

export const start = (job: IngestJob, now: string) => move(job, "running", now);

/** A job is done when anything came out of it; it fails only when every item failed. */
export const finish = (job: IngestJob, outcomes: Map<string, ItemOutcome>, now: string): IngestJob => {
  if (job.status !== "running") throw new Error(`Only a running ingest job can finish, not ${job.status}`);
  const items = job.items.map(item => {
    const outcome = outcomes.get(item.id) ?? { status: "failed" as const, error: "The engine did not report this item" };
    const { error: _error, ...rest } = item;
    return { ...rest, ...outcome } satisfies IngestItem;
  });
  const allFailed = items.every(item => item.status === "failed");
  return move(job, allFailed ? "failed" : "done", now, { items, ...(allFailed ? { error: "No item could be ingested" } : {}) });
};

export const fail = (job: IngestJob, error: string, now: string): IngestJob =>
  move(job, "failed", now, { error, items: job.items.map(item => item.status === "pending" ? { ...item, status: "failed", error } : item) });

/** A job left unfinished by a process that died. */
export const interrupt = (job: IngestJob, now: string) => fail(job, "interrupted", now);

export const isUnfinished = (job: IngestJob) => job.status === "queued" || job.status === "running";

/** The API shape: no account, no context. */
export const publicJob = (job: IngestJob) => ({
  id: job.id, product_id: job.productId, status: job.status, items: job.items,
  created_at: job.createdAt, updated_at: job.updatedAt,
  ...(job.error ? { error: job.error } : {}),
});
