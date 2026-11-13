import { HostedIngest, HostedIngestError, type IngestItem as HostedItem } from "../hostedAgents/ingest.js";
import { withLangfuseContext } from "../langfuse.js";
import { mediaTypeOf } from "./names.js";
import type { IngestEngine, Result, Source, StagedUploads } from "./ports.js";

const PLAIN_EXTENSIONS = /\.(md|markdown|txt)$/i;

/** Text that is already Markdown-compatible is stored as is; no hosted run. */
export class PlainTextEngine implements IngestEngine {
  constructor(private readonly staged: StagedUploads) {}
  accepts(source: Source) {
    return source.kind === "file" && (PLAIN_EXTENSIONS.test(source.name) || Boolean(source.mimeType?.toLowerCase().startsWith("text/")));
  }
  async ingest(_accountId: string, sources: Source[]): Promise<Result[]> {
    return Promise.all(sources.map(async (source): Promise<Result> => {
      if (source.kind !== "file") return { id: source.id, status: "failed", error: "Plain text engine takes files only" };
      const bytes = await this.staged.read(source.objectKey);
      return { id: source.id, status: "ok", markdown: bytes.toString("utf8") };
    }));
  }
}

/** Everything else runs on the thick hosted agent, one batch per call. */
export class HostedEngine implements IngestEngine {
  constructor(private readonly hosted: HostedIngest, private readonly staged: StagedUploads) {}
  accepts() { return true; }
  async ingest(accountId: string, sources: Source[], context: string, signal?: AbortSignal): Promise<Result[]> {
    const items: HostedItem[] = await Promise.all(sources.map(async (source): Promise<HostedItem> => source.kind === "link"
      ? { id: source.id, kind: "link", url: source.url }
      : { id: source.id, kind: "file", name: source.name, bytes: source.size, downloadUrl: await this.staged.downloadUrl(source.objectKey),
          ...(source.sha256 ? { sha256: source.sha256 } : {}), ...(source.mimeType ? { mimeType: source.mimeType } : {}) }));
    const sourceKinds = new Map(sources.map(source => [source.id, source.kind]));
    const sessionOf = (id: string) => ({ session: { provider: "kimi_hosted_agents" as const, id } });
    const outcome = await withLangfuseContext({ userId: accountId }, () => this.hosted.ingest({ accountId, items, context }, signal)).catch((error: unknown) => {
      if (!(error instanceof HostedIngestError)) throw error;
      return error;
    });
    if (outcome instanceof HostedIngestError) return sources.map(source => ({ id: source.id, status: "failed", error: outcome.message, ...sessionOf(outcome.sessionId) }));
    return outcome.items.map(item => ({
      id: item.id, status: item.status, ...sessionOf(outcome.sessionId),
      // An uploaded file is its own original and is copied in the store; only a link's original comes back through us.
      ...(item.original && sourceKinds.get(item.id) === "link" ? { original: { name: item.original.name, bytes: item.original.bytes, mediaType: mediaTypeOf(item.original.name) } } : {}),
      ...(item.markdown !== undefined ? { markdown: item.markdown } : {}),
      ...(item.error ? { error: item.error } : {}),
    }));
  }
}

/** Stands in for an engine that is not configured, so its items fail with the reason instead of vanishing. */
export class UnavailableEngine implements IngestEngine {
  constructor(private readonly reason: string) {}
  accepts() { return true; }
  async ingest(_accountId: string, sources: Source[]): Promise<Result[]> {
    return sources.map(source => ({ id: source.id, status: "failed", error: this.reason }));
  }
}

/** Each source goes to the first engine that accepts it; every engine gets one batch. An engine that throws fails only its own items. */
export class RoutingEngine implements IngestEngine {
  constructor(private readonly engines: IngestEngine[]) {}
  accepts(source: Source) { return this.engines.some(engine => engine.accepts(source)); }
  async ingest(accountId: string, sources: Source[], context: string, signal?: AbortSignal): Promise<Result[]> {
    const batches = new Map<IngestEngine, Source[]>();
    const unrouted: Source[] = [];
    for (const source of sources) {
      const engine = this.engines.find(candidate => candidate.accepts(source));
      if (engine) batches.set(engine, [...(batches.get(engine) ?? []), source]); else unrouted.push(source);
    }
    const settled = await Promise.all([...batches].map(([engine, batch]) =>
      engine.ingest(accountId, batch, context, signal).catch((error: unknown): Result[] =>
        batch.map(source => ({ id: source.id, status: "failed", error: error instanceof Error ? error.message : String(error) })))));
    return [...settled.flat(), ...unrouted.map((source): Result => ({ id: source.id, status: "failed", error: "No engine accepts this item" }))];
  }
}
