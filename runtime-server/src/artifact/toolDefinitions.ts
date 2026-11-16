import { z } from "zod";
import type { ToolDefinition } from "../tools.js";
import type { HostToolRunner } from "../serverTools.js";
import type { ConversationRecord, ConversationRunRecord } from "../conversationRepository.js";
import type { ReportPublisher } from "./publisher.js";
import type { ReportProgress } from "./progress.js";
import type { SearchProvider } from "../factoryAgents/search.js";
import { draftFiles, REPORT_FILE, type DraftStore } from "./drafts.js";

export const PUBLISH_REPORT_TOOL = "artifact.publish_report";
export const WEB_SEARCH_TOOL = "artifact.web_search";
export const DRAFT_TOOLS = ["artifact.write", "artifact.edit"] as const;

const draftTool = (name: string, modelName: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition => ({
  name, locality: "server", approval: "none", description, schema: z.object({}).passthrough(),
  model: { name: modelName, locality: "server", description, properties, required }
});

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
    description: `Publish the report file: one complete, self-contained HTML document under /report/ (normally ${REPORT_FILE}), written with write and edit and proofread with read. Call it once when the file is final. It returns "Report published." or the exact errors to fix in the file before calling again. Rendering can take a minute.`,
    properties: { path: { type: "string", description: `The report file, normally ${REPORT_FILE}.` } },
    required: ["path"]
  }
},
draftTool("artifact.write", "write", `Create or replace a file under /report/ with the whole content given. Use it to start ${REPORT_FILE} (doctype, style, cover and an empty <section> for each chapter), then fill the chapters with edit. Keep each call small.`,
  { path: { type: "string", description: `A file under /report/, e.g. ${REPORT_FILE}.` }, content: { type: "string", description: "The whole file." } }, ["path", "content"]),
draftTool("artifact.edit", "edit", "Replace exact text in a file under /report/: old_string must appear exactly once (or set replace_all). Use it to fill one chapter at a time and to fix what proofreading finds.",
  { path: { type: "string", description: "A file under /report/." }, old_string: { type: "string", description: "The exact text to replace." }, new_string: { type: "string", description: "The text to put in its place." }, replace_all: { type: "boolean", description: "Replace every occurrence." } }, ["path", "old_string", "new_string"]),
{
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
export const reportToolRunner = (publisher: ReportPublisher, conversation: ConversationRecord, run: Pick<ConversationRunRecord, "createdAt">, attempt: number, progress: ReportProgress, drafts: DraftStore, search?: SearchProvider): HostToolRunner => ({
  async run(name, args, signal) {
    const files = draftFiles(drafts, conversation.id);
    if (name === "write") return { output: await files.write(args) };
    if (name === "edit") return { output: await files.edit(args) };
    // read and ls of /report/ arrive here from the shared read/ls tools: /report/ is mounted beside /attachments/.
    if (name === "ls") return { output: await files.read({}) };
    if (name === "read") return { output: await files.read(args) };
    if (name === "web_search") {
      if (!search) throw new Error("Web search is unavailable on this server.");
      const query = String(args.query ?? "").trim(), objective = String(args.objective ?? "").trim();
      if (!query || !objective) throw new Error("web_search needs both query and objective.");
      return { output: JSON.stringify(await search.search({ query, objective }, signal)) };
    }
    if (name !== "publish_report") throw new Error(`No report tool: ${name}`);
    const html = await files.read({ path: args.path ?? REPORT_FILE });
    return { output: await publisher.publish({ conversation, html, attempt, progress, startedAt: Date.parse(run.createdAt) || Date.now(), signal }) };
  }
});
