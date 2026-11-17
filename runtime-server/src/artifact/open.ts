import type { ProductAnalytics } from "../analytics/port.js";
import type { AssetBlobs } from "../assets/domain.js";
import type { ChatAssets } from "../chat/assets.js";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import { PostgresArtifactConfigRepository } from "./config.js";
import { ArtifactMode } from "./mode.js";
import type { ReportRenderer } from "./ports.js";
import { PostgresReportRepository } from "./repositories.js";
import { PostgresDraftStore } from "./drafts.js";
import { PostgresPhasePrompts } from "./prompt.js";
import type { SearchProvider } from "../factoryAgents/search.js";

/** Report mode in production: Postgres for configs and reports, the Runtime's object store for files. The renderer is the caller's to choose. */
export async function openArtifactMode(options: { pool: PostgresQueryExecutor; blobs: AssetBlobs; assets: ChatAssets; renderer: ReportRenderer; analytics?: ProductAnalytics; search?: SearchProvider }): Promise<ArtifactMode> {
  const configs = new PostgresArtifactConfigRepository(options.pool);
  const reports = new PostgresReportRepository(options.pool);
  await configs.initialize();
  await reports.initialize();
  const drafts = new PostgresDraftStore(options.pool);
  await drafts.initialize();
  const phasePrompts = new PostgresPhasePrompts(options.pool);
  await phasePrompts.initialize();
  return new ArtifactMode({ configs, reports, renderer: options.renderer, blobs: options.blobs, assets: options.assets, analytics: options.analytics, search: options.search, drafts, phasePrompts });
}
