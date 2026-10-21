import type { AgentDefinition, Corpus, ExpertProduct, LiveRelease } from "./domain.js";

/** Where the Agent Builder's saved definition lives. */
export interface AgentDefinitionRepository {
  latestFor(product: ExpertProduct): Promise<AgentDefinition | null>;
}

/** Where the currently served release lives. */
export interface LiveReleaseRepository {
  currentFor(product: ExpertProduct): Promise<LiveRelease | null>;
}

/** Makes a corpus the live release of a product. */
export interface CorpusReleaser {
  release(product: ExpertProduct, corpus: Corpus): Promise<{ publishedAt: string; corpusDigest: string }>;
}
