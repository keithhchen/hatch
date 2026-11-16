import { z } from "zod";
import type { ToolDefinition } from "../tools.js";
import type { HostToolRunner } from "../serverTools.js";
import type { ConversationRecord, ConversationRunRecord } from "../conversationRepository.js";
import type { ReportPublisher } from "./publisher.js";
import type { ReportProgress } from "./progress.js";

export const PUBLISH_REPORT_TOOL = "artifact.publish_report";

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
}];

/** The report tools of one Run of one artifact conversation. */
export const reportToolRunner = (publisher: ReportPublisher, conversation: ConversationRecord, run: Pick<ConversationRunRecord, "createdAt">, attempt: number, progress: ReportProgress): HostToolRunner => ({
  async run(name, args, signal) {
    if (name !== "publish_report") throw new Error(`No report tool: ${name}`);
    return { output: await publisher.publish({ conversation, html: args.html, attempt, progress, startedAt: Date.parse(run.createdAt) || Date.now(), signal }) };
  }
});
