import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ClientToolName } from "./protocol.js";
import { deliveryWorkflowForRelease, type DeliveryWorkflow, type ResolvedCreatorRelease } from "./release.js";
import { loadAgentCorpus, readCorpusAsset } from "./agentCorpus.js";

const MAX_SKILL_CONTEXT_CHARS = 24_000;
const MAX_FEW_SHOT_CONTEXT_CHARS = 12_000;

export type MaterializedCreatorRelease = {
  systemPrompt: string;
  localTools: ClientToolName[];
  externalTools: string[];
  externalToolDefinitions?: Array<{
    id: string;
    kind: string;
    connection_ref?: string;
    operation?: string;
    tool_name?: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  }>;
  deliveryWorkflow?: DeliveryWorkflow;
  deliveryAuditContext: {
    productPromise: string;
    productBoundaries: string[];
    protectedKnowledge: string;
  };
};

export async function materializeCreatorRelease(
  release: ResolvedCreatorRelease,
  userQuery: string,
  advertisedLocalTools: ClientToolName[]
): Promise<MaterializedCreatorRelease> {
  if (release.agentCorpusRoot) {
    return materializeAgentCorpusRoot(release.agentCorpusRoot, userQuery, advertisedLocalTools);
  }
  const skills = await loadProtectedSkillInstructions(release);
  const fewShots = renderFewShots(release.private.few_shots);
  // Release Evals are the publish-time quality gate. A per-consumer-turn
  // reviewer remains available only for explicit regulated deployments; it
  // must not turn ordinary Creator Agents into a second hidden workflow that
  // blocks their actual work at runtime.
  const deliveryWorkflow = process.env.HATCH_RUNTIME_DELIVERY_AUDIT === "enforce"
    ? deliveryWorkflowForRelease(release)
    : undefined;
  const protectedKnowledge = [
    release.private.system_prompt,
    skills ? `<creator_skills>\n${skills}\n</creator_skills>` : "",
    fewShots ? `<creator_few_shots>\n${fewShots}\n</creator_few_shots>` : ""
  ].filter(Boolean).join("\n\n");
  return {
    systemPrompt: protectedKnowledge,
    localTools: permittedLocalTools(release, advertisedLocalTools),
    externalTools: permittedExternalTools(release),
    ...(deliveryWorkflow ? { deliveryWorkflow } : {}),
    deliveryAuditContext: {
      productPromise: release.public.product.promise,
      productBoundaries: release.public.product.boundaries,
      protectedKnowledge: [
        fewShots ? `<creator_few_shot_evidence>\n${fewShots}\n</creator_few_shot_evidence>` : ""
      ].filter(Boolean).join("\n\n")
    }
  };
}

export async function materializeAgentCorpusRoot(
  corpusRoot: string,
  userQuery: string,
  advertisedLocalTools: ClientToolName[]
): Promise<MaterializedCreatorRelease> {
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
  // Retrieval-only knowledge is never eagerly injected into the prompt. The
  // model sees hatch.file_search and decides when a long-tail lookup is
  // needed; ServerToolExecutor performs the scoped Qdrant search.
  const systemPrompt = [system, ...skillSections].filter(Boolean).join("\n\n");
  return {
    systemPrompt,
    localTools: corpusLocalTools(corpus, advertisedLocalTools),
    externalTools: corpusExternalTools(corpus),
    externalToolDefinitions: corpusExternalToolDefinitions(corpus),
    deliveryAuditContext: {
      productPromise: "",
      productBoundaries: [],
      protectedKnowledge: [system, ...skillSections].filter(Boolean).join("\n\n")
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
    .map((tool) => tool.id)
    .filter((value): value is string => typeof value === "string");
}

function corpusExternalToolDefinitions(corpus: Awaited<ReturnType<typeof loadAgentCorpus>>): NonNullable<MaterializedCreatorRelease["externalToolDefinitions"]> {
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

export function permittedExternalTools(release: ResolvedCreatorRelease): string[] {
  const policy = release.private.runtime_policy.external_tools;
  if (!Array.isArray(policy)) return [];
  return [...new Set(policy.filter((tool): tool is string => typeof tool === "string" && tool.length > 0))].sort();
}

export function permittedLocalTools(
  release: ResolvedCreatorRelease,
  advertisedLocalTools: ClientToolName[]
): ClientToolName[] {
  const privatePolicy = Array.isArray(release.private.runtime_policy.local_tools)
    ? release.private.runtime_policy.local_tools.filter((tool): tool is string => typeof tool === "string")
    : [];
  const publicPolicy = new Set(release.public.product.supported_local_capabilities);
  const privatePolicySet = new Set(privatePolicy);
  return advertisedLocalTools.filter((tool) => publicPolicy.has(tool) && privatePolicySet.has(tool));
}

async function loadProtectedSkillInstructions(release: ResolvedCreatorRelease): Promise<string> {
  const skillAssets = release.private.protected_skills.assets.filter((asset) => path.basename(asset.path) === "SKILL.md");
  const sections: string[] = [];
  let remaining = MAX_SKILL_CONTEXT_CHARS;
  for (const asset of skillAssets) {
    if (remaining <= 0) break;
    const content = await readFile(path.join(release.protectedSkillsRoot, asset.path), "utf8");
    const section = `## ${asset.id}\n${content}`.slice(0, remaining);
    sections.push(section);
    remaining -= section.length;
  }
  return sections.join("\n\n");
}

function renderFewShots(fewShots: Array<Record<string, unknown>>): string {
  const sections = fewShots.map((example, index) => {
    const question = typeof example.question === "string" ? example.question : undefined;
    const answer = typeof example.answer === "string" ? example.answer : undefined;
    if (question && answer) return `Example ${index + 1}\nUser: ${question}\nAssistant: ${answer}`;
    return `Example ${index + 1}\n${JSON.stringify(example)}`;
  });
  return sections.join("\n\n").slice(0, MAX_FEW_SHOT_CONTEXT_CHARS);
}
