import path from "node:path";
import type { CorpusPublisher } from "../corpusPublisher.js";
import type { CreatorRegistryReleaseStore } from "../creatorRegistryRelease.js";
import type { ArtifactObjectStore } from "../objectStore.js";
import { CorpusPublisherReleaser, RegistryLiveReleaseRepository } from "./adapters/registry.js";
import { WorkbenchAgentDefinitionRepository } from "./adapters/workbenchDefinitions.js";
import { ProductLiveService } from "./productLiveService.js";

export { ExpertProduct, SystemMissing } from "./domain.js";
export { ProductLiveService } from "./productLiveService.js";

/** Composition root: wires the production adapters into the service. */
export function createProductLive(deps: {
  factoryRoot: string;
  publisher: CorpusPublisher;
  releases: CreatorRegistryReleaseStore;
  objectStore: ArtifactObjectStore;
}): ProductLiveService {
  return new ProductLiveService(
    new WorkbenchAgentDefinitionRepository(path.join(deps.factoryRoot, "agent-chats")),
    new RegistryLiveReleaseRepository(deps.releases, deps.objectStore),
    new CorpusPublisherReleaser(deps.publisher),
  );
}
