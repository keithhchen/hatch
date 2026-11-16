import type { AssetScope } from "./domain.js";

/** What an attachment tool gives back: text, or text with an image the model should see. */
export type ToolOutput = string | { text: string; image?: { mimeType: string; data: string /* base64 */ } };

/** The tools the model calls over a conversation's attachments; each view of them (by message, or flat) supplies the same three. */
export interface AttachmentToolView {
  ls(scope: AssetScope, path?: string): Promise<string>;
  grep(scope: AssetScope, query: { pattern: string; path?: string; fixed?: boolean; ignoreCase?: boolean; context?: number; maxMatches?: number }): Promise<string>;
  readTool(scope: AssetScope, args: { path: string; offset?: number; page?: number }): Promise<ToolOutput>;
}
