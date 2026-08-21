import type { ClientToolName } from "./protocol.js";
import { agentCorpusDigest, loadAgentCorpus, readCorpusAsset } from "./agentCorpus.js";
import { hatchPlatformPrompt } from "./hatchPlatformPrompt.js";

export const MAX_MATERIALIZED_AGENT_PROMPT_BYTES = 4 * 1024 * 1024;

export class AgentCorpusChangedError extends Error {
  constructor() {
    super("This Creator Agent changed. Reconnect before starting another turn.");
    this.name = "AgentCorpusChangedError";
  }
}

export type MaterializedAgentCorpus = {
  systemPrompt: string;
  localTools: ClientToolName[];
  externalTools: string[];
  externalToolDefinitions: Array<{
    id: string;
    kind: string;
    connection_ref?: string;
    operation?: string;
    tool_name?: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  }>;
  deliveryAuditContext: {
    productPromise: string;
    productBoundaries: string[];
    protectedKnowledge: string;
  };
};

export async function materializeAgentCorpus(
  corpusRoot: string,
  _userQuery: string,
  advertisedLocalTools: ClientToolName[],
  expectedDigest?: string,
  signal?: AbortSignal
): Promise<MaterializedAgentCorpus> {
  signal?.throwIfAborted();
  const corpus = await loadAgentCorpus(corpusRoot, signal);
  if (expectedDigest && await agentCorpusDigest(corpusRoot, corpus, signal) !== expectedDigest) {
    throw new AgentCorpusChangedError();
  }
  const system = await readCorpusAsset(corpusRoot, corpus.instructions.system, signal);
  // Skill bodies and references are not eagerly materialized into the system
  // prompt. The session catalog is metadata-only, and the registered Skill
  // tool loads the selected bundle in the same Agent loop.
  // Retrieval-only knowledge is also never eagerly injected. hatch.file_search
  // performs an Agent-scoped lookup only when the model needs long-tail facts.
  const protectedKnowledge = `${hatchPlatformPrompt()}\n\n${system}`;
  if (Buffer.byteLength(protectedKnowledge, "utf8") > MAX_MATERIALIZED_AGENT_PROMPT_BYTES) {
    throw new Error(`Materialized Agent prompt exceeds the ${MAX_MATERIALIZED_AGENT_PROMPT_BYTES} byte limit`);
  }
  // Close the revalidation-to-materialization race: every read above checked
  // the old manifest's asset digest, and this final manifest digest ensures a
  // publish did not swap the root while those assets were being assembled.
  if (expectedDigest && await agentCorpusDigest(corpusRoot, corpus, signal) !== expectedDigest) {
    throw new AgentCorpusChangedError();
  }
  return {
    systemPrompt: protectedKnowledge,
    // Platform-local tools are a Desktop capability, not a Creator permission.
    // PR7 intentionally removed per-Agent/per-session File and Shell toggles:
    // once the Desktop advertises a tool, the native Workspace grant,
    // Ask/Allow policy, and local OS sandbox are the authority. Intersecting
    // with optional `local_harness` manifest entries made otherwise healthy
    // sessions silently lose file_list/shell_exec (for example an API-focused
    // Agent Corpus), even though the user had already chosen a Workspace.
    localTools: [...advertisedLocalTools],
    externalTools: corpusExternalTools(corpus),
    externalToolDefinitions: corpusExternalToolDefinitions(corpus),
    deliveryAuditContext: {
      productPromise: corpus.product.promise ?? "",
      productBoundaries: corpus.product.boundaries ?? [],
      protectedKnowledge
    }
  };
}

function corpusExternalTools(corpus: Awaited<ReturnType<typeof loadAgentCorpus>>): string[] {
  return corpus.tools
    .filter((tool) => tool.kind === "http_function" || tool.kind === "mcp_tool")
    .map((tool) => tool.id);
}

function corpusExternalToolDefinitions(
  corpus: Awaited<ReturnType<typeof loadAgentCorpus>>
): MaterializedAgentCorpus["externalToolDefinitions"] {
  return corpus.tools
    .filter((tool) => tool.kind === "http_function" || tool.kind === "mcp_tool")
    .map((tool) => ({
      id: tool.id,
      kind: tool.kind,
      ...(tool.connection_ref ? { connection_ref: tool.connection_ref } : {}),
      ...(tool.operation ? { operation: tool.operation } : {}),
      ...(tool.tool_name ? { tool_name: tool.tool_name } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.input_schema ? { input_schema: tool.input_schema } : {})
    }));
}
