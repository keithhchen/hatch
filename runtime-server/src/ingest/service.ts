import { createHash, randomUUID } from "node:crypto";
import { deterministicId, idempotent } from "../idempotency.js";
import { fail, finish, interrupt, queuedJob, start, type IngestInput, type IngestJob, type ItemOutcome } from "./job.js";
import { labelOfUrl, safeName, stemOf } from "./names.js";
import type { IngestEngine, IngestJobRepository, IngestSink, Result, Source } from "./ports.js";
import { log } from "../observability/log.js";

export const MAX_ITEMS = 50;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** The request body that can carry a file of MAX_FILE_BYTES as base64 inside JSON. */
export const INGEST_BODY_MAX_BYTES = Math.ceil(MAX_FILE_BYTES * 4 / 3) + 1024 * 1024;
const MAX_CONTEXT = 4000;
const RECENT = 20;
const HEARTBEAT_MS = 30_000;
/** A running job is touched every HEARTBEAT_MS; one silent this long has lost its process. */
export const STALE_MS = 120_000;

export class IngestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** One item as the API receives it. */
export type RawItem = { url?: unknown; name?: unknown; content_base64?: unknown; media_type?: unknown };

/** Runs work away from the request. Tests pass one that lets them wait for the work. */
export type InBackground = (work: () => Promise<void>) => void;
export const detached: InBackground = work => { void work().catch(error => log.error("ingest_failed", { error })); };

const invalid = (message: string) => new IngestError(400, "invalid_ingest", message);
const BASE64 = /^[A-Za-z0-9+/\r\n]*={0,2}$/;

/** Validates one raw item into a source and the input the job records. */
const accept = (raw: unknown, id: string): { source: Source; input: IngestInput } => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("Each item must be an object");
  const item = raw as RawItem;
  if (typeof item.url === "string") {
    const url = new URL(item.url.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw invalid("Only http and https links can be ingested");
    return { source: { id, kind: "link", url: url.toString() }, input: { url: url.toString() } };
  }
  if (typeof item.name === "string" && typeof item.content_base64 === "string") {
    const name = safeName(item.name, "");
    if (!name) throw invalid("A file needs a name");
    if (!BASE64.test(item.content_base64)) throw invalid(`${name}: content_base64 is not valid base64`);
    const bytes = Buffer.from(item.content_base64, "base64");
    if (!bytes.length) throw invalid(`${name}: the file is empty`);
    if (bytes.length > MAX_FILE_BYTES) throw new IngestError(413, "file_too_large", `${name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    const declared = typeof item.media_type === "string" && item.media_type.trim() ? item.media_type.trim().slice(0, 200) : undefined;
    return {
      source: { id, kind: "file", name, bytes, ...(declared ? { mimeType: declared } : {}) },
      input: { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), ...(declared ? { media_type: declared } : {}) },
    };
  }
  throw invalid("Each item needs a url, or a name with content_base64");
};

const parse = (items: unknown): Array<{ source: Source; input: IngestInput }> => {
  if (!Array.isArray(items) || !items.length) throw invalid("items must be a non-empty array");
  if (items.length > MAX_ITEMS) throw invalid(`At most ${MAX_ITEMS} items per job`);
  const accepted = items.map((raw, index) => {
    try { return accept(raw, `i${index + 1}`); }
    catch (error) {
      if (error instanceof IngestError) throw error;
      throw invalid(`Item ${index + 1} is not a valid url`);
    }
  });
  return accepted;
};

/** The file name stem or link label an item is stored under. */
const labelOf = (source: Source) => source.kind === "link" ? labelOfUrl(source.url) : stemOf(source.name);

/** Accepts ingest jobs, runs them in the background through an engine, and records where each result went. */
export class IngestService {
  constructor(private readonly deps: {
    jobs: IngestJobRepository;
    engine: IngestEngine;
    sink: IngestSink;
    inBackground?: InBackground;
    newId?: () => string;
    now?: () => string;
  }) {}

  private readonly settledListeners: Array<(job: IngestJob) => Promise<void>> = [];

  /** Who hears a job once it is done or failed and saved. A listener that fails changes nothing about the job. */
  onSettled(listener: (job: IngestJob) => Promise<void>): void { this.settledListeners.push(listener); }

  private now() { return this.deps.now?.() ?? new Date().toISOString(); }

  /** With an Idempotency-Key the job id comes from the key, so a repeat finds the first job instead of making another. */
  async submit(accountId: string, productId: string, items: unknown, context?: unknown, idempotencyKey?: string): Promise<IngestJob> {
    if (context !== undefined && typeof context !== "string") throw invalid("context must be text");
    if ((context ?? "").length > MAX_CONTEXT) throw invalid(`context may be at most ${MAX_CONTEXT} characters`);
    const accepted = parse(items);
    const id = idempotencyKey ? deterministicId(accountId, productId, "ingest", idempotencyKey) : this.deps.newId?.() ?? randomUUID();
    const fresh = queuedJob(id, accountId, productId, accepted.map(entry => entry.input), context?.trim() ?? "", this.now());
    const { value: job, replayed } = await this.once(fresh);
    if (replayed) return job;
    (this.deps.inBackground ?? detached)(() => this.track(this.run(job, accepted.map(entry => entry.source))));
    return job;
  }

  private readonly once = idempotent<IngestJob>(
    { create: job => this.deps.jobs.create(job), find: job => this.deps.jobs.get(job.accountId, job.productId, job.id) },
    (stored, fresh) => stored.context === fresh.context && JSON.stringify(stored.items.map(item => item.input)) === JSON.stringify(fresh.items.map(item => item.input)));

  get(accountId: string, productId: string, id: string) { return this.deps.jobs.get(accountId, productId, id); }
  recent(accountId: string, productId: string) { return this.deps.jobs.recent(accountId, productId, RECENT); }

  /** Jobs a dead process left behind will never finish: say so. A job another live process still touches is left alone. */
  async recoverInterrupted(staleMs = STALE_MS): Promise<number> {
    const left = await this.deps.jobs.unfinished(new Date(Date.now() - staleMs).toISOString());
    await Promise.all(left.map(job => this.deps.jobs.save(interrupt(job, this.now()))));
    return left.length;
  }

  private readonly inFlight = new Set<Promise<void>>();
  private track(work: Promise<void>): Promise<void> {
    this.inFlight.add(work);
    return work.finally(() => this.inFlight.delete(work));
  }

  /** Resolves when the jobs this process runs have settled. */
  async drain(): Promise<void> { while (this.inFlight.size) await Promise.allSettled([...this.inFlight]); }

  private async run(job: IngestJob, sources: Source[]): Promise<void> {
    const running = start(job, this.now());
    await this.deps.jobs.save(running);
    const beat = setInterval(() => void this.deps.jobs.touch(job.id, this.now()).catch(error => log.error("ingest_heartbeat_failed", { job: job.id, error })), HEARTBEAT_MS);
    beat.unref();
    const settled = await this.process(running, sources).then(
      outcomes => finish(running, outcomes, this.now()),
      error => fail(running, error instanceof Error ? error.message : String(error), this.now()))
      .finally(() => clearInterval(beat));
    await this.deps.jobs.save(settled);
    for (const listener of this.settledListeners) await listener(settled).catch(error => log.error("ingest_settled_listener_failed", { job: settled.id, message: error instanceof Error ? error.message : String(error) }));
  }

  private async process(job: IngestJob, sources: Source[]): Promise<Map<string, ItemOutcome>> {
    const results = await this.deps.engine.ingest(job.accountId, sources, job.context);
    const labels = new Map(sources.map(source => [source.id, labelOf(source)]));
    const outcomes = await Promise.all(results.filter(result => labels.has(result.id)).map(async (result): Promise<[string, ItemOutcome]> =>
      [result.id, await this.place(job, { id: result.id, label: labels.get(result.id)! }, result)]));
    return new Map(outcomes);
  }

  private async place(job: IngestJob, item: { id: string; label: string }, result: Result): Promise<ItemOutcome> {
    const session = result.session ? { session: result.session } : {};
    if (result.status === "failed") return { status: "failed", error: result.error ?? "Ingest failed", ...session };
    try {
      const placement = await this.deps.sink.store({ accountId: job.accountId, productId: job.productId, jobId: job.id }, item, result);
      if (!placement.markdown_path && !placement.original_ref) return { status: "failed", error: "The engine returned nothing for this item", ...session };
      return { status: result.status, ...placement, ...session, ...(result.error ? { error: result.error } : {}) };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error), ...session };
    }
  }
}
