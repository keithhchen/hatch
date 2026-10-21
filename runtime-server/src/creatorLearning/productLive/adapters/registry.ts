import type { CorpusPublisher } from "../../corpusPublisher.js";
import type { CreatorRegistryReleaseStore } from "../../creatorRegistryRelease.js";
import type { ArtifactObjectStore } from "../../objectStore.js";
import { Corpus, LiveRelease, type ExpertProduct } from "../domain.js";
import type { CorpusReleaser, LiveReleaseRepository } from "../ports.js";

/** Adapter: the registry live-release table plus the corpus object it points to. */
export class RegistryLiveReleaseRepository implements LiveReleaseRepository {
  constructor(private readonly releases: CreatorRegistryReleaseStore, private readonly objects: ArtifactObjectStore) {}

  async currentFor(product: ExpertProduct): Promise<LiveRelease | null> {
    const live = await this.releases.getLive(product.productId);
    if (!live) return null;
    const corpus = await this.objects.get(live.corpus_ref)
      .then((bytes) => Corpus.parse(JSON.parse(bytes.toString("utf8"))))
      .catch(() => null);
    return new LiveRelease(corpus, live.brief_spec, live.published_at);
  }
}

/** Adapter: releases through the existing CorpusPublisher upload path. */
export class CorpusPublisherReleaser implements CorpusReleaser {
  constructor(private readonly publisher: CorpusPublisher) {}

  async release(product: ExpertProduct, corpus: Corpus) {
    const result = await this.publisher.publishUploaded({
      creatorId: product.creatorId,
      productId: product.productId,
      productName: product.name,
      productPromise: product.promise,
      briefSpec: product.briefSpec,
      corpus: corpus.value,
      sourceFiles: [],
    });
    return { publishedAt: result.published.published_at, corpusDigest: result.corpus_digest };
  }
}
