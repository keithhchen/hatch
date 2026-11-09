import { authorizeToolCall, describeTool, type ClientGroup, type SurfaceTool, type ToolAuthorization } from "../surfaces/contract.js";
import { ClientToolNameSchema, type ClientToolName } from "../protocol.js";
import { ChatError } from "./principal.js";

/** Local tools need a machine the user controls. */
export const LOCAL_TOOL_CLIENTS: readonly ClientGroup[] = ["desktop", "cli"];

/** The full set, declared once: every Run of every conversation sees these, whatever the client. */
export const CLIENT_TOOL_NAMES: readonly ClientToolName[] = ClientToolNameSchema.options;

const surfaceToolOf = (name: ClientToolName, description: string): SurfaceTool => ({ name, description, supportedClients: LOCAL_TOOL_CLIENTS });

/** What the model reads for a local tool: the registry description plus where it runs. */
export const describeLocalTool = (name: ClientToolName, description: string): string => describeTool(surfaceToolOf(name, description));

/** The harness authorizes every call against the client of the latest message. */
export const authorizeLocalToolCall = (name: ClientToolName, client: ClientGroup): ToolAuthorization =>
  authorizeToolCall(surfaceToolOf(name, ""), client);

export const clientHasLocalTools = (client: ClientGroup): boolean => LOCAL_TOOL_CLIENTS.includes(client);

/** A Product that needs local tools is unavailable, not degraded, where there are none. */
export function assertProductUsable(requiresLocalTools: boolean, client: ClientGroup): void {
  if (requiresLocalTools && !clientHasLocalTools(client)) {
    throw new ChatError("product_requires_local_tools",
      `This Expert needs local tools. Available on: ${LOCAL_TOOL_CLIENTS.join(", ")}.`, 409);
  }
}

export const productRequiresLocalTools = (corpus: { tools: ReadonlyArray<{ kind: string }> }): boolean =>
  corpus.tools.some((tool) => tool.kind === "local_harness");
