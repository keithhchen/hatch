import type { AssetBlobs } from "../assets/domain.js";
import { PdfParsePageRenderer } from "../assets/pdfPages.js";
import { PostgresAssetRepository } from "../assets/repositories.js";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import { AgentBoxes } from "./boxes.js";
import { BoxliteProvider } from "./boxlite.js";
import type { BoxProvider } from "./ports.js";
import { VercelSandboxProvider } from "./vercelSandbox.js";
import { PostgresProductCapabilities } from "./capabilities.js";
import { BuyerFiles, FileLinks } from "./files.js";
import { HtmlLinks, HtmlPages, PostgresHtmlPageRepository } from "./htmlPages.js";
import { AgentBoxMode } from "./tools.js";

/** The box service HATCH_AGENT_BOX_PROVIDER names: `boxlite` (the default) or `vercel`; undefined without that service's credentials. */
export function agentBoxProviderFromEnvironment(environment: NodeJS.ProcessEnv): (BoxProvider & { workDir: string }) | undefined {
  const name = environment.HATCH_AGENT_BOX_PROVIDER?.trim() || "boxlite";
  if (name === "vercel") return VercelSandboxProvider.fromEnvironment(environment);
  if (name === "boxlite") return BoxliteProvider.fromEnvironment(environment);
  throw new Error(`HATCH_AGENT_BOX_PROVIDER is "boxlite" or "vercel" (got "${name}").`);
}

/**
 * Agent boxes in production: BoxLite (or Vercel Sandbox) for the boxes, the Runtime's database and object store for files and pages. Off (undefined)
 * without the chosen provider's credentials (BOXLITE_API_KEY, or the Vercel token, team and project), or without HATCH_CREDENTIALS_KEY to sign page links.
 */
export async function openAgentBoxMode(options: { pool: PostgresQueryExecutor; blobs: AssetBlobs; environment: NodeJS.ProcessEnv }): Promise<{ mode: AgentBoxMode; pages: HtmlPages; files: BuyerFiles } | undefined> {
  const { environment } = options;
  const provider = agentBoxProviderFromEnvironment(environment);
  const secret = environment.HATCH_CREDENTIALS_KEY?.trim();
  if (!provider || !secret) return undefined;
  const capabilities = new PostgresProductCapabilities(options.pool);
  const pageRepository = new PostgresHtmlPageRepository(options.pool);
  const assets = new PostgresAssetRepository(options.pool);
  await capabilities.initialize();
  await pageRepository.initialize();
  await assets.initialize();
  const origin = `https://${environment.HATCH_DOMAIN_ALIAS?.trim() || "gethatchapp.com"}`;
  const files = new BuyerFiles(assets, options.blobs, new FileLinks(secret, origin));
  const pages = new HtmlPages(pageRepository, files, new HtmlLinks(secret, origin));
  return { mode: new AgentBoxMode({ capabilities, boxes: new AgentBoxes(provider), workDir: provider.workDir, pdf: new PdfParsePageRenderer(), files, pages }), pages, files };
}
