import type { AgentTool } from "@earendil-works/pi-agent-core";
import { authorizeToolCall, describeTool, orderTools, type ClientGroup, type SurfaceTool } from "../surfaces/contract.js";

/** Which clients may run a tool. A tool nobody restricts runs on every client. */
export type ClientSupport = (toolName: string) => SurfaceTool["supportedClients"];
export const everywhere: ClientSupport = () => "*";

/**
 * The tool set as declared once: a fixed order, descriptions that say where each tool is available,
 * and every call authorized against the client of the latest message. The list never depends on who is asking.
 */
export function declareTools(tools: AgentTool[], support: ClientSupport, clientOf: () => ClientGroup): AgentTool[] {
  return orderTools(tools).map(tool => {
    const declaration: SurfaceTool = { name: tool.name, description: tool.description, supportedClients: support(tool.name) };
    return {
      ...tool,
      description: describeTool(declaration),
      execute: (callId, params, signal, onUpdate) => {
        const authorization = authorizeToolCall(declaration, clientOf());
        if (!authorization.allowed) throw new Error(authorization.error.message);
        return tool.execute(callId, params, signal, onUpdate);
      },
    };
  });
}
