import { createHash, randomUUID } from "node:crypto";
import { deterministicId, idempotent } from "../idempotency.js";
import { fail, finish, interrupt, queuedJob, start, type IngestInput, type IngestJob, type ItemOutcome } from "./job.js";
import { LocalArtifactObjectStore, type ArtifactObjectStore } from "../creatorLearning/objectStore.js";
import { labelOfUrl, mediaTypeOf, safeName, stemOf } from "./names.js";
import type { IngestEngine, IngestJobRepository, IngestSink, Result, Source } from "./ports.js";
import { log } from "../observability/log.js";
import type { UsageCap } from "../usage/usageCap.js";

export const MAX_ITEMS = 50;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Files never travel in the request: a body only names uploads and links. */
export const INGEST_BODY_MAX_BYTES = 256 * 1024;
/** Where uploads wait for their job. A prefix of its own, so one bucket lifecycle rule can expire what no job claimed. */
export const UPLOADS_ROOT = "ingest-uploads";
/** How long a browser has to PUT a file after asking for the upload. */
export const UPLOAD_SECONDS = 15 * 60;
const MAX_CONTEXT = 4000;
const RECENT = 20;
const HEARTBEAT_MS = 30_000;
/** A running job is touched every HEARTBEAT_MS; one silent this long has lost its process. */
export const STALE_MS = 120_000;

export class IngestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** One item as the API receives it: a link, or a file the browser already uploaded to its slot. */
export type RawItem = { url?: unknown; upload_id?: unknown; name?: unknown; bytes?: unknown; media_type?: unknown; sha256?: unknown };
/** What the browser tells about a file when it asks where to upload it. */
export type UploadRequest = Omit<RawItem, "url" | "upload_id">;
export type StagedFileItem = { upload_id: string; name: string; bytes: number; media_type: string; sha256: string };
export type UploadSlot = { upload_id: string; url: string; method: "PUT"; headers: Record<string, string>; expires_at: string };

/** Runs work away from the request. Tests pass one that lets them wait for the work. */
export type InBackground = (work: () => Promise<void>) => void;
export const detached: InBackground = work => { void work().catch(error => log.error("ingest_failed", { error })); };

const invalid = (message: string) => new IngestError(400, "invalid_ingest", message);
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The file facts both the upload request and the submit carry, validated. */
const describeFile = (item: UploadRequest) => {
  const name = typeof item.name === "string" ? safeName(item.name, "") : "";
  if (!name) throw invalid("A file needs a name");
  if (typeof item.bytes !== "number" || !Number.isInteger(item.bytes) || item.bytes < 1) throw invalid(`${name}: bytes must be the file's size, above zero`);
  if (item.bytes > MAX_FILE_BYTES) throw new IngestError(413, "file_too_large", `${name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const sha256 = typeof item.sha256 === "string" ? item.sha256.toLowerCase() : undefined;
  if (item.sha256 !== undefined && !(sha256 && SHA256.test(sha256))) throw invalid(`${name}: sha256 must be 64 hex characters`);
  const declared = typeof item.media_type === "string" && item.media_type.trim() ? item.media_type.trim().slice(0, 200) : undefined;
  return { name, bytes: item.bytes, ...(sha256 ? { sha256 } : {}), ...(declared ? { declared } : {}), contentType: mediaTypeOf(name, declared) };
};

const base = (contentType: string) => contentType.split(";")[0]!.trim().toLowerCase();

/** Validates one raw item into a source and the input the job records. */
const accept = async (raw: unknown, id: string, objects: UploadChecks): Promise<{ source: Source; input: IngestInput }> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("Each item must be an object");
  const item = raw as RawItem;
  if (typeof item.url === "string") {
    const url = new URL(item.url.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw invalid("Only http and https links can be ingested");
    return { source: { id, kind: "link", url: url.toString() }, input: { url: url.toString() } };
  }
  if (typeof item.upload_id === "string") {
    const file = describeFile(item);
    if (!UPLOAD_ID.test(item.upload_id)) throw invalid(`${file.name}: upload_id is not valid`);
    const objectKey = objects.keyOf(item.upload_id, file.name);
    const stored = await objects.head(objectKey);
    if (!stored) throw new IngestError(409, "upload_not_found", `${file.name} was not uploaded (or its upload link expired). Upload it again.`);
    if (stored.bytes !== file.bytes) throw new IngestError(422, "upload_size_mismatch", `${file.name}: ${stored.bytes} bytes arrived, ${file.bytes} expected. Upload it again.`);
    if (stored.contentType && base(stored.contentType) !== base(file.contentType)) throw new IngestError(422, "upload_type_mismatch", `${file.name}: stored as ${stored.contentType}, expected ${file.contentType}. Upload it again.`);
    return {
      source: { id, kind: "file", name: file.name, size: file.bytes, objectKey, ...(file.sha256 ? { sha256: file.sha256 } : {}), ...(file.declared ? { mimeType: file.declared } : {}) },
      input: { name: file.name, bytes: file.bytes, ...(file.sha256 ? { sha256: file.sha256 } : {}), ...(file.declared ? { media_type: file.declared } : {}) },
    };
  }
  throw invalid("Each item needs a url, or an upload_id with name and bytes");
};

type UploadChecks = { keyOf(uploadId: string, name: string): string; head: ArtifactObjectStore["head"] };

const parse = async (items: unknown, objects: UploadChecks): Promise<Array<{ source: Source; input: IngestInput }>> => {
  if (!Array.isArray(items) || !items.length) throw invalid("items must be a non-empty array");
  if (items.length > MAX_ITEMS) throw invalid(`At most ${MAX_ITEMS} items per job`);
  return Promise.all(items.map(async (raw, index) => {
    try { return await accept(raw, `i${index + 1}`, objects); }
    catch (error) {
      if (error instanceof IngestError) throw error;
      throw invalid(`Item ${index + 1} is not a valid url`);
    }
  }));
};

/** The file name stem or link label an item is stored under. */
const labelOf = (source: Source) => source.kind === "link" ? labelOfUrl(source.url) : stemOf(source.name);

/** Accepts ingest jobs, runs them in the background through an engine, and records where each result went. */
export class IngestService {
  constructor(private readonly deps: {
    jobs: IngestJobRepository;
    engine: IngestEngine;
    sink: IngestSink;
    /** Whether the account owns the Product. Jobs are only made for, and read from, a Product the account owns. */
    owns: (accountId: string, productId: string) => Promise<boolean>;
    /** A job is not started when the account has spent its month: the hosted agent's model calls are the Expert's. */
    usageCap?: UsageCap;
    /** Where browsers upload files to, and where a job finds them. */
    objects: ArtifactObjectStore;
    inBackground?: InBackground;
    newId?: () => string;
    now?: () => string;
  }) {}

  private readonly settledListeners: Array<(job: IngestJob) => Promise<void>> = [];

  /** Who hears a job once it is done or failed and saved. A listener that fails changes nothing about the job. */
  onSettled(listener: (job: IngestJob) => Promise<void>): void { this.settledListeners.push(listener); }

  private async assertOwns(accountId: string, productId: string): Promise<void> {
    if (!await this.deps.owns(accountId, productId)) throw new IngestError(404, "product_not_found", "Product was not found.");
  }

  private now() { return this.deps.now?.() ?? new Date().toISOString(); }

  private keyOf(accountId: string, productId: string, uploadId: string, name: string) {
    return `${UPLOADS_ROOT}/${accountId}/${productId}/${uploadId}/${name}`;
  }

  /** Where the browser PUTs one file: a short-lived link to a key only this Product's job can claim. */
  async requestUpload(accountId: string, productId: string, request: UploadRequest): Promise<UploadSlot> {
    await this.assertOwns(accountId, productId);
    const file = describeFile(request);
    const uploadId = this.deps.newId?.() ?? randomUUID();
    const signed = await this.deps.objects.presign(this.keyOf(accountId, productId, uploadId, file.name), { method: "PUT", expiresSeconds: UPLOAD_SECONDS, contentType: file.contentType });
    return { upload_id: uploadId, url: signed.url, method: "PUT", headers: signed.headers, expires_at: signed.expiresAt };
  }

  /** For callers that already hold the bytes (the Assistant): stores them in a slot and returns the submit item that names it. */
  async stage(accountId: string, productId: string, file: { name: string; bytes: Buffer; media_type: string }): Promise<StagedFileItem> {
    await this.assertOwns(accountId, productId);
    const item = { name: file.name, bytes: file.bytes.length, media_type: file.media_type, sha256: createHash("sha256").update(file.bytes).digest("hex") };
    const described = describeFile(item);
    const uploadId = this.deps.newId?.() ?? randomUUID();
    await this.deps.objects.put(this.keyOf(accountId, productId, uploadId, described.name), file.bytes, { contentType: described.contentType });
    return { upload_id: uploadId, ...item, name: described.name };
  }

  /** Dev only: the Local store's upload links point at the Registry, which stores the bytes when the signed link is valid. */
  async receiveLocalUpload(key: string, query: URLSearchParams, bytes: Buffer, contentType: string | undefined): Promise<void> {
    if (!(this.deps.objects instanceof LocalArtifactObjectStore)) throw new IngestError(404, "not_found", "Not found.");
    await this.deps.objects.receive(key, query, bytes, contentType).catch(error => { throw new IngestError(403, "upload_link_invalid", error instanceof Error ? error.message : String(error)); });
  }

  /** With an Idempotency-Key the job id comes from the key, so a repeat finds the first job instead of making another. */
  async submit(accountId: string, productId: string, items: unknown, context?: unknown, idempotencyKey?: string): Promise<IngestJob> {
    await this.assertOwns(accountId, productId);
    await this.deps.usageCap?.assertWithinCap(accountId);
    if (context !== undefined && typeof context !== "string") throw invalid("context must be text");
    if ((context ?? "").length > MAX_CONTEXT) throw invalid(`context may be at most ${MAX_CONTEXT} characters`);
    const accepted = await parse(items, { keyOf: (uploadId, name) => this.keyOf(accountId, productId, uploadId, name), head: key => this.deps.objects.head(key) });
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

  async get(accountId: string, productId: string, id: string) { await this.assertOwns(accountId, productId); return this.deps.jobs.get(accountId, productId, id); }
  async recent(accountId: string, productId: string) { await this.assertOwns(accountId, productId); return this.deps.jobs.recent(accountId, productId, RECENT); }

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
