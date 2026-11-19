import path from "node:path";
import { z } from "zod";
import type { PdfPageRenderer } from "../assets/pdfPages.js";
import type { ToolOutput } from "../assets/toolOutput.js";
import type { ToolDefinition } from "../tools.js";
import type { AgentBoxes, BoxOwner } from "./boxes.js";
import type { ProductCapabilities } from "./capabilities.js";
import { AGENT_BOX_CAPABILITY } from "./capabilities.js";
import type { BuyerFiles } from "./files.js";
import type { HtmlPages } from "./htmlPages.js";
import { BoxToolError } from "./ports.js";
import type { ReportEmailJob, ReportEmails } from "./reportEmail.js";
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, Workspace } from "./workspace.js";

export const BOX_TOOLS = ["box.bash", "box.write", "box.edit", "box.save_file", "box.publish_html"] as const;
/** A turn with a box audits, fetches and writes over many calls: the budget of a report turn (see REPORT_TOOL_CALL_LIMIT). */
export const BOX_TOOL_CALL_LIMIT = { max: 100, uncounted: [] as string[] };
const MAX_SAVED_BYTES = 20 * 1024 * 1024;

/** A box tool's result, or a refusal the model can act on. */
export type BoxToolResult = Record<string, unknown>;
const shown = (output: ToolOutput): BoxToolResult => typeof output === "string" ? { output }
  : { output: output.text, ...output.image ? { content_type: "image", mime_type: output.image.mimeType, data_base64: output.image.data } : {} };
const refused = (code: string, message: string): BoxToolResult => ({ status: "error", error: { code, message } });

/** The box tools of one conversation: `read` and `ls` of a path in the box arrive here too, from the shared tools. */
export interface BoxToolRunner {
  owns(path: unknown): boolean;
  run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BoxToolResult>;
}

const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[], readOnly = false): ToolDefinition => ({
  name: `box.${name}`, locality: "server", approval: "none", description, readOnly, schema: z.object({}).passthrough(),
  model: { name, locality: "server", description, properties, required }
});

/** The registry entries. A conversation sees them only when its turn names them (see AgentBoxMode.turnFor). */
export const boxToolDefinitions = (workDir: string): ToolDefinition[] => [
  definition("bash", `Run a shell command on your own Linux computer (Python 3, Node, Chromium, Playwright, pandas, curl; internet access). It starts in ${workDir}, where you keep your files; they stay between conversations with this user. read and ls also open files under ${workDir}. Output is cut to its start and end when long. timeout is in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, at most ${MAX_TIMEOUT_SECONDS}); run longer jobs in the background and check on them.`,
    { command: { type: "string", description: "The shell command." }, timeout: { type: "number", description: "Seconds before the command is stopped." } }, ["command"]),
  definition("write", `Create or replace a text file under ${workDir} with the whole content given. Keep each call small: start a long file, then fill it with edit.`,
    { path: { type: "string", description: `A path under ${workDir}, or relative to it.` }, content: { type: "string", description: "The whole file." } }, ["path", "content"]),
  definition("edit", `Replace exact text in a file under ${workDir}: old_string must appear exactly once (or set replace_all).`,
    { path: { type: "string" }, old_string: { type: "string", description: "The exact text to replace." }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, ["path", "old_string", "new_string"]),
  definition("save_file", `Keep a file from ${workDir} for the user (an HTML page, a PDF, an image): returns its file_id and a url: a link the user can open or download. Never invent file links; give the user this url. Saving the same content again returns the same id. Save again after changing the file.`,
    { path: { type: "string", description: `The file under ${workDir}.` } }, ["path"]),
  definition("publish_html", "Publish a saved HTML file as a web page and get its link to send to the user. The page is a whole HTML document; it is shown as is, scripts allowed. The same file_id gives the same link; a changed page is a new save and a new link. When the user gave an email address, the link is emailed to them automatically; do not send it yourself.",
    { file_id: { type: "string", description: "The id save_file returned." }, title: { type: "string", description: "The page's name." } }, ["file_id", "title"])
];

/** What the box tools need, shared by every conversation. */
export type AgentBoxDeps = { capabilities: ProductCapabilities; boxes: AgentBoxes; workDir: string; pdf: PdfPageRenderer; files: BuyerFiles; pages: HtmlPages; reportEmail?: ReportEmails };

/** What the report email of a conversation needs beyond the page: where it goes and what it says. Without a recipient nothing is sent. */
export type ReportEmailContext = Omit<ReportEmailJob, "pageId" | "recipient" | "reportUrl"> & { recipient?: string };

export class AgentBoxMode {
  constructor(private readonly deps: AgentBoxDeps) {}

  definitions(): ToolDefinition[] { return boxToolDefinitions(this.deps.workDir); }

  /**
   * The box tools of a turn, or undefined when the Product has none. A visitor who has not signed in has the tools but
   * every call says to sign in: the box and its files are a buyer's own.
   */
  async turnFor(owner: { productId: string; userId: string; guest: boolean; email?: ReportEmailContext }): Promise<{ extraTools: string[]; tools: BoxToolRunner } | undefined> {
    if (!await this.deps.capabilities.has(owner.productId, AGENT_BOX_CAPABILITY)) return undefined;
    return { extraTools: [...BOX_TOOLS], tools: owner.guest ? this.guestRunner() : this.runner({ productId: owner.productId, buyer: owner.userId }, owner.email) };
  }

  private owns = (raw: unknown) => typeof raw === "string" && (raw === this.deps.workDir || raw.startsWith(`${this.deps.workDir}/`));

  private guestRunner(): BoxToolRunner {
    return { owns: this.owns, run: async () => refused("login_required", "This needs the user to sign in first. Tell them to sign in, then ask again.") };
  }

  private runner(owner: BoxOwner, email?: ReportEmailContext): BoxToolRunner {
    const { boxes, workDir, pdf, files, pages, reportEmail } = this.deps;
    const scope = { kind: "buyer" as const, productId: owner.productId, userId: owner.buyer };
    let workspace: Promise<Workspace> | undefined;
    // The box is opened on the first call that needs it, once per turn.
    const box = () => (workspace ??= boxes.of(owner).then(opened => new Workspace(opened, workDir, pdf)).catch(error => { workspace = undefined; throw error; }));
    return {
      owns: this.owns,
      async run(name, args, signal) {
        try {
          switch (name) {
            case "bash": return shown(await (await box()).bash(args, signal));
            case "write": return shown(await (await box()).write(args));
            case "edit": return shown(await (await box()).edit(args));
            case "read": return shown(await (await box()).read(args));
            case "ls": return shown(await (await box()).ls(args));
            case "save_file": {
              const opened = await box();
              const file = opened.resolve(args.path);
              const bytes = await opened.bytes(file, MAX_SAVED_BYTES);
              const saved = await files.save(scope, path.posix.basename(file), bytes);
              return { file_id: saved.id, name: saved.name, mime: saved.mime, bytes: saved.bytes, url: saved.url };
            }
            case "publish_html": {
              if (typeof args.file_id !== "string" || typeof args.title !== "string") throw new BoxToolError("file_id and title are strings.");
              const published = await pages.publish(scope, args.file_id, args.title);
              // After the publish has succeeded and without waiting for it: the email never delays or fails the tool.
              if (reportEmail && email?.recipient) {
                void reportEmail.notify({ ...email, recipient: email.recipient, pageId: published.page_id, reportUrl: published.url });
              }
              return published;
            }
            default: throw new Error(`No box tool: ${name}`);
          }
        } catch (error) {
          if (error instanceof BoxToolError) return refused("invalid_call", error.message);
          throw error;
        }
      }
    };
  }
}
