import type { ClientToolName, ToolRequest } from "./protocol.js";
import type { ClientToolBroker } from "./clientBroker.js";
import type { ServerToolExecutor } from "./serverTools.js";
import type { RunStateMachine } from "./runState.js";
import { requireClientToolEnabled, requireTool } from "./tools.js";

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
};

/**
 * The single gateway shared by MainAgentRuntime and SkillRuntime. Scope is
 * correlation/routing metadata; both runtimes use the same app capability set.
 */
export class ToolBridge {
  constructor(
    private readonly clientBroker: ClientToolBroker,
    private readonly serverTools: ServerToolExecutor
  ) {}

  async execute(request: ToolBridgeRequest): Promise<Record<string, unknown>> {
    const tool = requireTool(request.name);
    const parsed = tool.schema.parse(request.arguments) as Record<string, unknown>;

    if (tool.locality === "server") {
      return this.serverTools.execute(request.name, parsed);
    }

    requireClientToolEnabled(request.clientTools, request.name as ClientToolName);
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
