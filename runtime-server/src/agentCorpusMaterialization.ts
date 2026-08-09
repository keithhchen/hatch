import type { ClientToolName } from "./protocol.js";
import { loadAgentCorpus, readCorpusAsset } from "./agentCorpus.js";

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
  userQuery: string,
  advertisedLocalTools: ClientToolName[]
): Promise<MaterializedAgentCorpus> {
  const corpus = await loadAgentCorpus(corpusRoot);
  const system = await readCorpusAsset(corpusRoot, corpus.instructions.system);
  const activeSkills = corpus.skills.filter((skill) => skillMatchesQuery(skill.name, skill.when_to_use, userQuery));
  const skillSections: string[] = [];
  for (const skill of activeSkills) {
    const instruction = await readCorpusAsset(corpusRoot, skill.instruction);
    const references = [];
    for (const reference of skill.references) {
      references.push(`### ${reference.kind}\n${await readCorpusAsset(corpusRoot, reference.asset)}`);
    }
    skillSections.push(`<creator_skill id=${JSON.stringify(skill.id)}>\n${instruction}${references.length ? `\n\n${references.join("\n\n")}` : ""}\n</creator_skill>`);
  }
  // Retrieval-only knowledge is never eagerly injected. hatch.file_search
  // performs an Agent-scoped lookup only when the model needs long-tail facts.
  const protectedKnowledge = [system, ...skillSections].filter(Boolean).join("\n\n");
  return {
    systemPrompt: protectedKnowledge,
    localTools: corpusLocalTools(corpus, advertisedLocalTools),
    externalTools: corpusExternalTools(corpus),
    externalToolDefinitions: corpusExternalToolDefinitions(corpus),
    deliveryAuditContext: {
      productPromise: corpus.product.promise ?? "",
      productBoundaries: corpus.product.boundaries ?? [],
      protectedKnowledge
    }
  };
}

function skillMatchesQuery(name: string, whenToUse: string, query: string): boolean {
  const terms = new Set(`${name} ${whenToUse}`.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
  if (terms.size === 0) return false;
  const queryTerms = query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return queryTerms.some((term) => terms.has(term));
}

function corpusLocalTools(
  corpus: Awaited<ReturnType<typeof loadAgentCorpus>>,
  advertised: ClientToolName[]
): ClientToolName[] {
  const capabilities = new Set(corpus.tools.filter((tool) => tool.kind === "local_harness").map((tool) => tool.capability));
  const allowed = new Set<ClientToolName>();
  if (capabilities.has("filesystem")) {
    for (const tool of ["fs.list", "fs.search", "fs.read", "fs.write", "fs.patch"] as ClientToolName[]) allowed.add(tool);
  }
  if (capabilities.has("shell")) allowed.add("shell.exec");
  if (capabilities.has("git")) allowed.add("git.diff");
  return advertised.filter((tool) => allowed.has(tool));
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
