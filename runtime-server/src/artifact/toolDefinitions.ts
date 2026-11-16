import { z } from "zod";
import type { ToolDefinition } from "../tools.js";
import type { HostToolRunner } from "../serverTools.js";
import type { ConversationRecord, ConversationRunRecord } from "../conversationRepository.js";
import type { ReportPublisher } from "./publisher.js";
import type { ReportProgress } from "./progress.js";
import type { SearchProvider } from "../factoryAgents/search.js";

export const PUBLISH_REPORT_TOOL = "artifact.publish_report";
export const WEB_SEARCH_TOOL = "artifact.web_search";

/** The registry entry: server-side, not read-only (it writes the report), visible only to a conversation that names it. */
export const artifactToolDefinitions = (): ToolDefinition[] => [{
  name: PUBLISH_REPORT_TOOL,
  locality: "server",
  approval: "none",
  description: "Publish the report.",
  schema: z.object({}).passthrough(),
  model: {
    name: "publish_report",
    locality: "server",
    description: "Publish the report: one complete, self-contained HTML document following the report rules. Call it once when the report is written. It returns \"Report published.\" or the exact errors to fix before calling again. Rendering can take a minute.",
    properties: { html: { type: "string", description: "The complete HTML document." } },
    required: ["html"]
  }
}, {
  name: WEB_SEARCH_TOOL,
  locality: "server",
  approval: "none",
  readOnly: true,
  description: "Search the public web.",
  schema: z.object({}).passthrough(),
  model: {
    name: "web_search",
    locality: "server",
    description: "Search the public web for facts that change over time: schools' current requirements, deadlines, programs, costs. `query` is a few distinctive keywords, not a sentence. `objective` says what the search serves and which sources should rank first (the school's own site, official and recent pages). Returns sources with relevant excerpts and URLs.",
    properties: { query: { type: "string", description: "A few distinctive keywords." }, objective: { type: "string", description: "What this search serves and what a good result looks like." } },
    required: ["query", "objective"]
  }
}];

/** The report tools of one Run of one artifact conversation. */
export const reportToolRunner = (publisher: ReportPublisher, conversation: ConversationRecord, run: Pick<ConversationRunRecord, "createdAt">, attempt: number, progress: ReportProgress, search?: SearchProvider): HostToolRunner => ({
  async run(name, args, signal) {
    if (name === "web_search") {
      if (!search) throw new Error("Web search is unavailable on this server.");
      const query = String(args.query ?? "").trim(), objective = String(args.objective ?? "").trim();
      if (!query || !objective) throw new Error("web_search needs both query and objective.");
      return { output: JSON.stringify(await search.search({ query, objective }, signal)) };
    }
    if (name !== "publish_report") throw new Error(`No report tool: ${name}`);
    return { output: await publisher.publish({ conversation, html: args.html, attempt, progress, startedAt: Date.parse(run.createdAt) || Date.now(), signal }) };
  }
});
