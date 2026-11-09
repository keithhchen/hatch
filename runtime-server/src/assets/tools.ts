import { z } from "zod";
import type { SurfaceTool } from "../surfaces/contract.js";
import type { AssetScope } from "./domain.js";
import { FileToolError, type AttachmentFiles } from "./files.js";

/** A SurfaceTool plus how to run it. The scope comes from the authenticated conversation, never from the model. */
export type AttachmentTool = SurfaceTool & { parameters: Record<string, unknown>; run(scope: AssetScope, args: unknown): Promise<string> };

const define = <S extends z.ZodType>(meta: SurfaceTool, schema: S, body: (scope: AssetScope, args: z.infer<S>) => Promise<string>): AttachmentTool => ({
  ...meta,
  parameters: z.toJSONSchema(schema) as Record<string, unknown>,
  async run(scope, args) {
    const parsed = schema.safeParse(args);
    if (!parsed.success) return `Error: ${parsed.error.issues.map(i => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ")}`;
    try { return await body(scope, parsed.data); }
    catch (error) {
      if (error instanceof FileToolError) return `Error: ${error.message}`;
      throw error;
    }
  }
});

/** The Chat API's Unix-style retrieval: ls, grep, paged read. All three are read-only. */
export const attachmentTools = (files: AttachmentFiles): AttachmentTool[] => [
  define({ name: "ls", supportedClients: "*", description: "List attachments. Paths look like /attachments/<message_id>/<name>. Without a path, lists the messages that have attachments." },
    z.object({ path: z.string().optional() }), (scope, { path }) => files.ls(scope, path)),
  define({ name: "grep", supportedClients: "*", description: "Search attachment text for a fixed string (fixed=true) or a regular expression. Prints path:line: text with optional context lines. Output is bounded; narrow with path." },
    z.object({ pattern: z.string(), path: z.string().optional(), fixed: z.boolean().optional(), ignoreCase: z.boolean().optional(), context: z.number().int().optional(), maxMatches: z.number().int().optional() }),
    (scope, args) => files.grep(scope, args)),
  define({ name: "read", supportedClients: "*", description: "Read an attachment's text in pages. Returns content, offset, next_offset and total_chars; call again with offset=next_offset to continue until it is null. To summarize or judge a whole document, read every page (grep finds facts, it does not cover a document); ls shows the size." },
    z.object({ path: z.string(), offset: z.number().int().optional(), limit: z.number().int().optional() }),
    async (scope, { path, offset, limit }) => JSON.stringify(await files.read(scope, path, offset, limit)))
];
