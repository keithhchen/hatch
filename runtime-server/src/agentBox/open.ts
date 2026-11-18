import type { AssetBlobs } from "../assets/domain.js";
import { PdfParsePageRenderer } from "../assets/pdfPages.js";
import { PostgresAssetRepository } from "../assets/repositories.js";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import { AgentBoxes } from "./boxes.js";
import { BoxliteProvider } from "./boxlite.js";
import { PostgresProductCapabilities } from "./capabilities.js";
import { BuyerFiles } from "./files.js";
import { HtmlLinks, HtmlPages, PostgresHtmlPageRepository } from "./htmlPages.js";
import { AgentBoxMode } from "./tools.js";

/**
 * Agent boxes in production: BoxLite for the boxes, the Runtime's database and object store for files and pages. Off (undefined)
 * without BOXLITE_API_KEY, or without HATCH_CREDENTIALS_KEY to sign page links.
 */
export async function openAgentBoxMode(options: { pool: PostgresQueryExecutor; blobs: AssetBlobs; environment: NodeJS.ProcessEnv }): Promise<{ mode: AgentBoxMode; pages: HtmlPages } | undefined> {
  const { environment } = options;
  const provider = BoxliteProvider.fromEnvironment(environment);
  const secret = environment.HATCH_CREDENTIALS_KEY?.trim();
  if (!provider || !secret) return undefined;
  const capabilities = new PostgresProductCapabilities(options.pool);
  const pageRepository = new PostgresHtmlPageRepository(options.pool);
  const assets = new PostgresAssetRepository(options.pool);
  await capabilities.initialize();
  await pageRepository.initialize();
  await assets.initialize();
  const files = new BuyerFiles(assets, options.blobs);
  const pages = new HtmlPages(pageRepository, files, new HtmlLinks(secret, `https://${environment.HATCH_DOMAIN_ALIAS?.trim() || "gethatchapp.com"}`));
  return { mode: new AgentBoxMode({ capabilities, boxes: new AgentBoxes(provider), workDir: provider.workDir, pdf: new PdfParsePageRenderer(), files, pages }), pages };
}
