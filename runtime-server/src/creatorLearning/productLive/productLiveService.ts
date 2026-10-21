import { InvalidSkills, ProductLiveView, SystemMissing, type ExpertProduct, type PublishedProduct } from "./domain.js";
import type { AgentDefinitionRepository, CorpusReleaser, LiveReleaseRepository } from "./ports.js";

/** Application service for `/v1/creator/products/:id/live`. Depends on ports only. */
export class ProductLiveService {
  constructor(
    private readonly definitions: AgentDefinitionRepository,
    private readonly releases: LiveReleaseRepository,
    private readonly releaser: CorpusReleaser,
  ) {}

  async status(product: ExpertProduct): Promise<ProductLiveView> {
    const [definition, live] = await Promise.all([this.definitions.latestFor(product), this.releases.currentFor(product)]);
    return new ProductLiveView(product, definition, live);
  }

  async publish(product: ExpertProduct): Promise<PublishedProduct> {
    const definition = await this.definitions.latestFor(product);
    if (!definition) throw new SystemMissing();
    if (!definition.publishable) throw new InvalidSkills(definition.invalidSkills);
    const released = await this.releaser.release(product, definition.toCorpus());
    return {
      product_id: product.productId,
      status: "published",
      published_at: released.publishedAt,
      corpus_digest: released.corpusDigest,
      public_url: product.publicUrl,
    };
  }
}
