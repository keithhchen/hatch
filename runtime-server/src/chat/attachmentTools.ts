import { z } from "zod";
import { describeTool } from "../surfaces/contract.js";
import type { AttachmentTool } from "../assets/tools.js";
import type { ToolDefinition } from "../tools.js";

/** The registry entry for each attachment tool: server-side and read-only, so a Run that used only these may restart. Arguments are validated by the tool itself. */
export const attachmentToolDefinitions = (tools: readonly AttachmentTool[]): ToolDefinition[] => tools.map((tool) => ({
  name: `attachments.${tool.name}`,
  locality: "server",
  approval: "none",
  readOnly: true,
  description: tool.description,
  schema: z.object({}).passthrough(),
  model: {
    name: tool.name,
    locality: "server",
    description: describeTool(tool),
    properties: tool.parameters.properties as Record<string, unknown>,
    required: (tool.parameters.required as string[] | undefined) ?? []
  }
}));
