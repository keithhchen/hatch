import type { ClientToolName, ToolRequest } from "./protocol.js";
import type { ClientToolBroker } from "./clientBroker.js";
import type { ServerToolExecutor } from "./serverTools.js";
import type { RunStateMachine } from "./runState.js";
import { requireClientToolEnabled, requireTool } from "./tools.js";
import { authorizeToolCall, type ClientGroup } from "./surfaces/contract.js";
import { authorizeLocalToolCall } from "./chat/toolSurface.js";

export type ToolRuntimeScope = "main" | "skill_run";

export type ToolBridgeRequest = {
  scope: ToolRuntimeScope;
  runId: string;
  skillRunId?: string;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  clientTools: ClientToolName[];
  state: RunStateMachine;
  signal?: AbortSignal;
};

/**
 * The single gateway shared by MainAgentRuntime and SkillRuntime. Scope is
 * correlation/routing metadata; both runtimes use the same app capability set.
 */
export class ToolBridge {
  constructor(
    private readonly clientBroker: ClientToolBroker,
    private readonly serverTools: ServerToolExecutor,
    /** The client of the latest message. When given, it authorizes every local tool call. */
    private readonly clientOf?: () => ClientGroup
  ) {}

  async execute(request: ToolBridgeRequest): Promise<Record<string, unknown>> {
    const tool = requireTool(request.name);
    const parsed = tool.schema.parse(request.arguments) as Record<string, unknown>;

    if (tool.locality === "server") {
      if (tool.supportedClients && this.clientOf) {
        const authorization = authorizeToolCall({ name: tool.model?.name ?? tool.name, description: "", supportedClients: tool.supportedClients }, this.clientOf());
        if (!authorization.allowed) throw Object.assign(new Error(authorization.error.message), { code: authorization.error.code });
      }
      return this.serverTools.execute(request.name, parsed, request.signal);
    }

    requireClientToolEnabled(request.clientTools, request.name as ClientToolName);
    const authorization = this.clientOf ? authorizeLocalToolCall(request.name as ClientToolName, this.clientOf()) : { allowed: true as const };
    if (!authorization.allowed) throw Object.assign(new Error(authorization.error.message), { code: authorization.error.code });
    const options: {
      scope: ToolRequest["scope"];
      skillRunId?: string;
    } = { scope: request.scope };
    if (request.skillRunId) options.skillRunId = request.skillRunId;
    return this.clientBroker.execute(
      request.runId,
      request.name,
      parsed,
      request.state,
      request.toolCallId,
      options
    );
  }
}
