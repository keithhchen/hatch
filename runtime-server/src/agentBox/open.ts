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
import { PostgresLeadRepository, ReportLeads, type ContactOf } from "./reportLeads.js";
import { ReportEmails, ResendSender } from "./reportEmail.js";
import { AgentBoxMode } from "./tools.js";
import { PostgresPrompts } from "../prompts.js";

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
export async function openAgentBoxMode(options: { pool: PostgresQueryExecutor; blobs: AssetBlobs; environment: NodeJS.ProcessEnv }): Promise<{ mode: AgentBoxMode; pages: HtmlPages; files: BuyerFiles; origin: string; reportLeads: (contactOf: ContactOf) => ReportLeads } | undefined> {
  const { environment } = options;
  const provider = agentBoxProviderFromEnvironment(environment);
  const secret = environment.HATCH_CREDENTIALS_KEY?.trim();
  if (!provider || !secret) return undefined;
  const capabilities = new PostgresProductCapabilities(options.pool);
  const pageRepository = new PostgresHtmlPageRepository(options.pool);
  const assets = new PostgresAssetRepository(options.pool);
  await capabilities.initialize();
  await pageRepository.initialize();
  const leadRepository = new PostgresLeadRepository(options.pool);
  await leadRepository.initialize();
  await assets.initialize();
  const origin = `https://${environment.HATCH_DOMAIN_ALIAS?.trim() || "gethatchapp.com"}`;
  const files = new BuyerFiles(assets, options.blobs, new FileLinks(secret, origin));
  const links = new HtmlLinks(secret, origin);
  const pages = new HtmlPages(pageRepository, files, links);
  // The report email: off (logged, not faked) without RESEND_API_KEY.
  const apiKey = environment.RESEND_API_KEY?.trim();
  const reportEmail = new ReportEmails({
    pages: pageRepository, prompts: new PostgresPrompts(options.pool), ...apiKey ? { sender: new ResendSender(apiKey) } : {},
    from: environment.HATCH_REPORT_EMAIL_FROM?.trim() || `Hatch <reports@${environment.HATCH_DOMAIN_ALIAS?.trim() || "gethatchapp.com"}>`,
    ...environment.HATCH_REPORT_EMAIL_REPLY_TO?.trim() ? { replyTo: environment.HATCH_REPORT_EMAIL_REPLY_TO.trim() } : {}
  });
  return { mode: new AgentBoxMode({ capabilities, boxes: new AgentBoxes(provider), workDir: provider.workDir, pdf: new PdfParsePageRenderer(), files, pages, reportEmail }), pages, files, origin, reportLeads: contactOf => new ReportLeads(pageRepository, links, leadRepository, contactOf) };
}
