import type { AssetBlobs } from "../assets/domain.js";
import { PdfParsePageRenderer } from "../assets/pdfPages.js";
import { PostgresAssetRepository } from "../assets/repositories.js";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import { AgentBoxes } from "./boxes.js";
import { BoxliteProvider } from "./boxlite.js";
import { PostgresProductCapabilities } from "./capabilities.js";
import { BuyerFiles, FileLinks } from "./files.js";
import { HtmlLinks, HtmlPages, PostgresHtmlPageRepository } from "./htmlPages.js";
import { ReportEmails, ResendSender } from "./reportEmail.js";
import { AgentBoxMode } from "./tools.js";
import { PostgresPrompts } from "../prompts.js";

/**
 * Agent boxes in production: BoxLite for the boxes, the Runtime's database and object store for files and pages. Off (undefined)
 * without BOXLITE_API_KEY, or without HATCH_CREDENTIALS_KEY to sign page links.
 */
export async function openAgentBoxMode(options: { pool: PostgresQueryExecutor; blobs: AssetBlobs; environment: NodeJS.ProcessEnv }): Promise<{ mode: AgentBoxMode; pages: HtmlPages; files: BuyerFiles; origin: string } | undefined> {
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
  const origin = `https://${environment.HATCH_DOMAIN_ALIAS?.trim() || "gethatchapp.com"}`;
  const files = new BuyerFiles(assets, options.blobs, new FileLinks(secret, origin));
  const pages = new HtmlPages(pageRepository, files, new HtmlLinks(secret, origin));
  // The report email: off (logged, not faked) without RESEND_API_KEY.
  const apiKey = environment.RESEND_API_KEY?.trim();
  const reportEmail = new ReportEmails({
    pages: pageRepository, prompts: new PostgresPrompts(options.pool), ...apiKey ? { sender: new ResendSender(apiKey) } : {},
    from: environment.HATCH_REPORT_EMAIL_FROM?.trim() || `Hatch <reports@${environment.HATCH_DOMAIN_ALIAS?.trim() || "gethatchapp.com"}>`,
    ...environment.HATCH_REPORT_EMAIL_REPLY_TO?.trim() ? { replyTo: environment.HATCH_REPORT_EMAIL_REPLY_TO.trim() } : {}
  });
  return { mode: new AgentBoxMode({ capabilities, boxes: new AgentBoxes(provider), workDir: provider.workDir, pdf: new PdfParsePageRenderer(), files, pages, reportEmail }), pages, files, origin };
}
