import type { ClientToolName } from "./protocol.js";
import type { ClientToolBroker } from "./clientBroker.js";
import type { ServerToolExecutor } from "./serverTools.js";
import type { RunStateMachine } from "./runState.js";
import { requireClientToolEnabled, requireTool } from "./tools.js";

export type ToolBridgeRequest = {
  runId: string;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  clientTools: ClientToolName[];
  state: RunStateMachine;
  signal?: AbortSignal;
};

/**
 * The single gateway shared by the Agent runtime and Skill loader. Both use
 * the same app capability set and ordinary tool lifecycle.
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
      return this.serverTools.execute(request.name, parsed, request.signal);
    }

    requireClientToolEnabled(request.clientTools, request.name as ClientToolName);
    return this.clientBroker.execute(
      request.runId,
      request.name,
      parsed,
      request.state,
      request.toolCallId
    );
  }
}
