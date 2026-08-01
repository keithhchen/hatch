import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ClientToolName } from "./protocol.js";
import { deliveryWorkflowForRelease, type DeliveryWorkflow, type ResolvedCreatorRelease } from "./release.js";

const MAX_SKILL_CONTEXT_CHARS = 24_000;
const MAX_RAG_CONTEXT_CHARS = 12_000;
const MAX_AUDIT_RAG_CONTEXT_CHARS = 4_000;
const MAX_AUDIT_RAG_CANDIDATES = 2;
const MAX_FEW_SHOT_CONTEXT_CHARS = 12_000;

export type MaterializedCreatorRelease = {
  systemPrompt: string;
  localTools: ClientToolName[];
  externalTools: string[];
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
  const [skills, ragCandidates] = await Promise.all([
    loadProtectedSkillInstructions(release),
    loadRankedRagCandidates(release, userQuery)
  ]);
  const rag = renderRagContext(ragCandidates, 8, MAX_RAG_CONTEXT_CHARS);
  const auditRag = renderRagContext(
    ragCandidates,
    MAX_AUDIT_RAG_CANDIDATES,
    MAX_AUDIT_RAG_CONTEXT_CHARS
  );
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
    rag ? `<creator_knowledge_retrieval query=${JSON.stringify(userQuery)}>\n${rag}\n</creator_knowledge_retrieval>` : "",
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
        auditRag ? `<creator_knowledge_evidence query=${JSON.stringify(userQuery)}>\n${auditRag}\n</creator_knowledge_evidence>` : "",
        fewShots ? `<creator_few_shot_evidence>\n${fewShots}\n</creator_few_shot_evidence>` : ""
      ].filter(Boolean).join("\n\n")
    }
  };
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

async function loadRankedRagCandidates(
  release: ResolvedCreatorRelease,
  query: string
): Promise<Array<{ id: string; text: string; score: number }>> {
  const candidates: Array<{ id: string; text: string; score: number }> = [];
  for (const asset of release.private.rag.documents) {
    const raw = await readFile(path.join(release.ragRoot, asset.path), "utf8");
    for (const [index, text] of extractTextCandidates(raw).entries()) {
      candidates.push({ id: `${asset.id}#${index + 1}`, text, score: lexicalScore(query, text) });
    }
  }
  return candidates.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function renderRagContext(
  candidates: Array<{ id: string; text: string; score: number }>,
  maxCandidates: number,
  maxChars: number
): string {
  let remaining = maxChars;
  const sections: string[] = [];
  for (const candidate of candidates.slice(0, maxCandidates)) {
    if (remaining <= 0) break;
    const section = `[${candidate.id}]\n${candidate.text}`.slice(0, remaining);
    sections.push(section);
    remaining -= section.length;
  }
  return sections.join("\n\n");
}

function extractTextCandidates(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    const candidates: string[] = [];
    collectText(parsed, candidates);
    return candidates.filter((text) => text.trim().length > 0);
  } catch {
    return raw.split(/\n{2,}/).map((text) => text.trim()).filter(Boolean);
  }
}

function collectText(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) output.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const preferred = ["text", "content", "chunk", "answer", "question"]
    .map((key) => record[key])
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (preferred.length) {
    output.push(preferred.join("\n"));
    return;
  }
  for (const child of Object.values(record)) collectText(child, output);
}

function lexicalScore(query: string, text: string): number {
  const terms = new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
  const haystack = text.toLocaleLowerCase();
  let score = 0;
  for (const term of terms) if (haystack.includes(term)) score += 1;
  return score;
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
