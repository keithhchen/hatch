import type { IngestJob, ProviderSession } from "./job.js";

/** One thing to ingest, with the bytes in hand. */
export type Source = { id: string } & ({ kind: "link"; url: string } | { kind: "file"; name: string; bytes: Buffer; mimeType?: string });
export type Original = { name: string; bytes: Buffer; mediaType?: string };
export type Result = { id: string; status: "ok" | "partial" | "failed"; original?: Original; markdown?: string; session?: ProviderSession; error?: string };

/** Turns sources into originals plus Markdown. A new way of ingesting is one class. */
export interface IngestEngine {
  accepts(source: Source): boolean;
  ingest(accountId: string, sources: Source[], context: string, signal?: AbortSignal): Promise<Result[]>;
}

export type Placement = { markdown_path?: string; original_ref?: string };

/** Puts a result where the Product keeps its material. */
export interface IngestSink {
  store(scope: { accountId: string; productId: string; jobId: string }, item: { id: string; label: string }, result: Result): Promise<Placement>;
}

export interface IngestJobRepository {
  /** False when a job with this id already exists; nothing is written then. */
  create(job: IngestJob): Promise<boolean>;
  save(job: IngestJob): Promise<void>;
  get(accountId: string, productId: string, id: string): Promise<IngestJob | undefined>;
  recent(accountId: string, productId: string, limit: number): Promise<IngestJob[]>;
  /** Heartbeat of the process running the job: pushes `updatedAt` forward while the job is unfinished. */
  touch(id: string, now: string): Promise<void>;
  /** Unfinished jobs nobody has touched since `staleBefore`. */
  unfinished(staleBefore: string): Promise<IngestJob[]>;
}
