import type { ArtifactObjectStore } from "../creatorLearning/objectStore.js";
import path from "node:path";
import { mediaTypeOf, safeName, stemOf } from "./names.js";
import type { IngestSink, Placement, Result } from "./ports.js";

/** The Product's shared `input/manual/` files, as the sink needs them. */
export interface ManualFiles {
  list(): Promise<string[]>;
  read(name: string): Promise<Buffer>;
  write(name: string, bytes: Buffer): Promise<void>;
}

const MANUAL = "input/manual/";

/** Runs jobs of the same key one after another, so two writers never pick the same free name. */
const serialized = () => {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(work, work);
    tails.set(key, run.catch(() => undefined));
    return run;
  };
};

/**
 * The first free name: `stem.md`, then `stem-2.md`, ... A name holding the very same bytes is reused;
 * a name holding anything else is never overwritten.
 */
export const placeManual = async (files: ManualFiles, stem: string, bytes: Buffer): Promise<string> => {
  const taken = new Set((await files.list()).map(file => file.normalize("NFC")));
  const candidate = (n: number) => `${MANUAL}${stem}${n === 1 ? "" : `-${n}`}.md`;
  const pick = async (n: number): Promise<string> => {
    const name = candidate(n);
    if (!taken.has(name)) { await files.write(name, bytes); return name; }
    return (await files.read(name)).equals(bytes) ? name : pick(n + 1);
  };
  return pick(1);
};

/**
 * An original is named after what the user gave us: the input's name with the extension of the stored bytes
 * (a compressed talk.mov is kept as talk.mp4), never the engine's internal artifact name.
 */
export const originalName = (label: string, stored: string) =>
  safeName(`${stemOf(label)}${path.extname(stored) || path.extname(label)}`, safeName(stored));

/** Markdown goes to the Product's shared manual files; the original goes to the object store under the Product's prefix. */
export class ProductWorkspaceSink implements IngestSink {
  private readonly one = serialized();
  constructor(
    private readonly manual: (accountId: string, productId: string) => Promise<ManualFiles>,
    private readonly objects: ArtifactObjectStore,
    private readonly productPrefix: (accountId: string, productId: string) => string,
  ) {}

  async store(scope: { accountId: string; productId: string; jobId: string }, item: { id: string; label: string }, result: Result): Promise<Placement> {
    const markdown = result.markdown?.trim() ? await this.one(`${scope.accountId}/${scope.productId}`, async () =>
      placeManual(await this.manual(scope.accountId, scope.productId), item.label, Buffer.from(result.markdown!, "utf8"))) : undefined;
    const original = result.original && await this.putOriginal(scope, item, result.original);
    return { ...(markdown ? { markdown_path: markdown } : {}), ...(original ? { original_ref: original } : {}) };
  }

  private async putOriginal(scope: { accountId: string; productId: string; jobId: string }, item: { id: string; label: string }, original: NonNullable<Result["original"]>) {
    const key = `${this.productPrefix(scope.accountId, scope.productId)}/ingest/${scope.jobId}/${item.id}/${originalName(item.label, original.name)}`;
    await this.objects.put(key, original.bytes, { contentType: mediaTypeOf(original.name, original.mediaType) });
    return key;
  }
}
