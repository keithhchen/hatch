import type { CreatorQa, CreatorQuestion, EvaluationVerdict } from "./types.js";

const QUESTION_HEADING = /^##\s+((?:[A-Za-z][\w-]*\.)?Q\d+)(?:\s*[-—:]\s*(.*))?\s*$/gim;
const FACTORY_QUESTION_BLOCK = /^<!-- HATCH_FACTORY_QUESTION_BEGIN -->\r?\n/gm;
const CREATOR_QUESTION_BATCH_MARKER = /<!-- HATCH_CREATOR_QUESTION_BATCH_ID: (qbatch_v1_[a-f0-9]{64}) -->/g;

export const CORPUS_COMPILATION_END_MARKER = "HATCH_CORPUS_COMPILATION_COMPLETE";
export const CORPUS_ASSET_BEGIN_MARKER = "<!-- HATCH_CORPUS_ASSET_BEGIN -->";
export const CORPUS_ASSET_CONTENT_MARKER = "<!-- HATCH_CORPUS_ASSET_CONTENT -->";
export const CORPUS_ASSET_END_MARKER = "<!-- HATCH_CORPUS_ASSET_END -->";

const CORPUS_COMPILATION_SECTIONS = [
  "Change rationale",
  "Requirements traceability",
  "Preservation audit",
  "Compilation complete"
] as const;

const PRESERVATION_AUDIT_SECTIONS = [
  "Retained",
  "Added or changed",
  "Removed",
  "Merged",
  "Conflict resolutions",
  "Asset identity, path, or layer changes"
] as const;

const CORPUS_ASSET_LAYERS = ["system", "skill", "reference", "knowledge"] as const;
const REFERENCE_KINDS = ["method", "style", "example", "few_shots"] as const;
const CORPUS_IDENTIFIER = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const TOOL_IDENTIFIER = /^(?:hatch|creator)\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export type CorpusReferenceKind = typeof REFERENCE_KINDS[number];

export type CorpusSkill = {
  id: string;
  path: string;
  name: string;
  whenToUse: string;
  allowedToolIds: string[];
  content: string;
};

export type CorpusSkillReference = {
  id: string;
  path: string;
  parentSkillId: string;
  kind: CorpusReferenceKind;
  content: string;
};

export type CorpusKnowledgeDocument = {
  id: string;
  path: string;
  sourceSummary: string;
  retrievalOnly: true;
  content: string;
};

export type CorpusCompilation = {
  format: "layered-assets";
  systemInstructions: string;
  skills: CorpusSkill[];
  references: CorpusSkillReference[];
  knowledge: CorpusKnowledgeDocument[];
  changeRationale: string;
  requirementsTraceability: string;
  preservationAudit: string;
};

export type ParseCorpusCompilationOptions = {
  /** The externally declared tool IDs Skills are allowed to reference. */
  availableToolIds?: readonly string[];
};

export function parseQuestions(markdown: string): CreatorQuestion[] {
  const factoryBlocks = [...markdown.matchAll(FACTORY_QUESTION_BLOCK)];
  if (factoryBlocks.length > 0) {
    return factoryBlocks.map((marker, index) => {
      const blockStart = (marker.index ?? 0) + marker[0].length;
      const blockEnd = factoryBlocks[index + 1]?.index ?? markdown.length;
      const block = markdown.slice(blockStart, blockEnd);
      const heading = block.match(/^##\s+((?:[A-Za-z][\w-]*\.)?Q\d+)(?:\s*[-—:]\s*(.*))?\s*$/im);
      if (!heading) throw new Error(`Factory question block ${index + 1} has no canonical heading`);
      return parseQuestionBlock(heading[1]!, block.slice((heading.index ?? 0) + heading[0].length));
    });
  }
  const matches = [...markdown.matchAll(QUESTION_HEADING)];
  return matches.map((match, index) => {
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? markdown.length;
    return parseQuestionBlock(match[1]!, markdown.slice(bodyStart, bodyEnd));
  });
}

function parseQuestionBlock(id: string, body: string): CreatorQuestion {
    const question = namedSection(body, "Question", ["Why this question", "Intent", "Creator Answer", "Leakage group"])
      || firstContentBlock(body);
    const intent = namedSection(body, "Why this question", ["Intent", "Creator Answer", "Leakage group"])
      || namedSection(body, "Intent", ["Creator Answer", "Leakage group"]);
    const leakageGroup = namedSection(body, "Leakage group", ["Creator Answer"]);
    if (!question.trim()) throw new Error(`Question ${id} has no question body`);
    return {
      id,
      question: question.trim(),
      ...(intent.trim() ? { intent: intent.trim() } : {}),
      ...(leakageGroup.trim() ? { leakageGroup: leakageGroup.trim() } : {})
    };
}

export function renderCreatorAnswerTemplate(questions: CreatorQuestion[], questionBatchId: string): string {
  if (!/^qbatch_v1_[a-f0-9]{64}$/.test(questionBatchId)) {
    throw new Error("Creator answer template requires a canonical run-scoped Question batch ID");
  }
  return [
    "# Creator answers",
    "",
    `<!-- HATCH_CREATOR_QUESTION_BATCH_ID: ${questionBatchId} -->`,
    "",
    "> 请保留题号和 Question，只填写 Creator Answer。答案将用于 development 或 sealed held-out；分区由 Hatch 完成。",
    "",
    ...questions.flatMap((item) => [
      `## ${item.id}`,
      "",
      "### Question",
      "",
      item.question,
      "",
      "### Creator Answer",
      "",
      "<!-- 在这里作答 -->",
      ""
    ])
  ].join("\n");
}

/**
 * Creator answers stay loose Markdown inside one strict transport envelope.
 * The run-scoped batch ID prevents fixed IDs such as I.Q1—and even identical
 * Question bytes—from attaching an answer document to another run.
 */
export function parseCreatorAnswerQuestionBatchId(markdown: string): string {
  const matches = [...markdown.matchAll(CREATOR_QUESTION_BATCH_MARKER)];
  if (matches.length !== 1) {
    throw new Error("Creator answer document must contain exactly one run-scoped Question batch ID marker");
  }
  return matches[0]![1]!;
}

export function parseCreatorAnswers(markdown: string, expected: CreatorQuestion[]): CreatorQa[] {
  const matches = [...markdown.matchAll(QUESTION_HEADING)];
  const byId = new Map<string, CreatorQa>();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? markdown.length;
    const body = markdown.slice(bodyStart, bodyEnd);
    const expectedQuestion = expected.find((item) => item.id === match[1]);
    if (!expectedQuestion) continue;
    const answer = tailSection(body, "Creator Answer")
      .replace(/<!--[^]*?-->/g, "")
      .trim();
    if (!answer) continue;
    byId.set(expectedQuestion.id, { ...expectedQuestion, answer });
  }
  return expected.flatMap((item) => byId.has(item.id) ? [byId.get(item.id)!] : []);
}

export function renderQaSet(title: string, rows: CreatorQa[]): string {
  return [
    `# ${title}`,
    "",
    ...rows.flatMap((item) => [
      `## ${item.id}`,
      "",
      "### Question",
      "",
      item.question,
      "",
      ...(item.intent ? ["### Why this question", "", item.intent, ""] : []),
      "### Leakage group",
      "",
      item.leakageGroup || item.id,
      "",
      "### Creator Answer",
      "",
      item.answer,
      ""
    ])
  ].join("\n");
}

export function parseQaSet(markdown: string): CreatorQa[] {
  return parseQuestions(markdown).map((question) => {
    const block = questionBlock(markdown, question.id);
    const answer = tailSection(block, "Creator Answer").trim();
    if (!answer) throw new Error(`QA ${question.id} has no Creator Answer`);
    return { ...question, answer };
  });
}

export function parseEvaluation(markdown: string): EvaluationVerdict {
  const verdictText = namedSection(markdown, "Verdict", ["Diagnosis", "Few-shot candidate", "Corpus reflection"])
    .trim()
    .toUpperCase();
  if (verdictText !== "PASS" && verdictText !== "FAIL") {
    throw new Error("Eval LLM must return PASS or FAIL under ## Verdict");
  }
  return {
    pass: verdictText === "PASS",
    diagnosis: namedSection(markdown, "Diagnosis", ["Few-shot candidate", "Corpus reflection"]).trim(),
    fewShot: namedSection(markdown, "Few-shot candidate", ["Corpus reflection"]).trim(),
    corpusReflection: tailSection(markdown, "Corpus reflection").trim(),
    raw: markdown
  };
}

export function extractCorpus(markdown: string, options: ParseCorpusCompilationOptions = {}): string {
  return parseCorpusCompilation(markdown, options).systemInstructions;
}

/**
 * Parses the complete cognitive-asset compiler envelope. Asset contents are
 * delimited by reserved exact marker lines, so any Markdown heading is valid
 * inside System, Skill, reference, and knowledge documents.
 */
export function parseCorpusCompilation(
  markdown: string,
  options: ParseCorpusCompilationOptions = {}
): CorpusCompilation {
  const availableToolIds = validateAvailableToolIds(options.availableToolIds ?? []);
  const assetBlocks = parseCorpusAssetBlocks(markdown, availableToolIds);
  const firstBlock = assetBlocks[0];
  const lastBlock = assetBlocks.at(-1);
  if (!firstBlock || !lastBlock) {
    throw new Error(`Corpus compilation must contain asset blocks delimited by ${CORPUS_ASSET_BEGIN_MARKER}`);
  }

  const prefix = markdown.slice(0, firstBlock.beginIndex).trim();
  if (prefix !== "# Compiled cognitive assets") {
    throw new Error("Corpus compilation must start with exactly one # Compiled cognitive assets heading");
  }
  const auditEnvelope = markdown.slice(lastBlock.endIndex);
  const headings = CORPUS_COMPILATION_SECTIONS.map((title) => {
    const matches = topLevelHeadingMatches(auditEnvelope, title);
    if (matches.length !== 1) {
      throw new Error(`Corpus compilation must contain exactly one # ${title} section`);
    }
    return matches[0]!;
  });

  for (let index = 1; index < headings.length; index += 1) {
    if (headings[index]!.index <= headings[index - 1]!.index) {
      throw new Error(`Corpus compilation sections are out of order near # ${CORPUS_COMPILATION_SECTIONS[index]}`);
    }
  }
  if (auditEnvelope.slice(0, headings[0]!.index).trim()) {
    throw new Error("Corpus compilation contains content outside asset blocks before # Change rationale");
  }

  const bodies = headings.map((match, index) => {
    const start = match.index + match.text.length;
    const end = headings[index + 1]?.index ?? auditEnvelope.length;
    return auditEnvelope.slice(start, end).trim();
  });
  const [changeRationale, requirementsTraceability, preservationAudit, completion] = bodies;

  requireCompilationBody("Change rationale", changeRationale);
  requireCompilationBody("Requirements traceability", requirementsTraceability);
  requireCompilationBody("Preservation audit", preservationAudit);
  validatePreservationAudit(preservationAudit!);
  if (completion !== CORPUS_COMPILATION_END_MARKER) {
    throw new Error(`Corpus compilation is incomplete: # Compilation complete must end with ${CORPUS_COMPILATION_END_MARKER}`);
  }

  const systemAssets = assetBlocks.filter((asset) => asset.layer === "system");
  if (systemAssets.length !== 1) {
    throw new Error("Corpus compilation must contain exactly one system asset");
  }
  const skills = assetBlocks.filter((asset): asset is ParsedSkillBlock => asset.layer === "skill");
  const references = assetBlocks.filter((asset): asset is ParsedReferenceBlock => asset.layer === "reference");
  const knowledge = assetBlocks.filter((asset): asset is ParsedKnowledgeBlock => asset.layer === "knowledge");

  return {
    format: "layered-assets",
    systemInstructions: systemAssets[0]!.content,
    skills: skills.map(({ beginIndex: _beginIndex, endIndex: _endIndex, layer: _layer, ...skill }) => skill),
    references: references.map(({ beginIndex: _beginIndex, endIndex: _endIndex, layer: _layer, ...reference }) => reference),
    knowledge: knowledge.map(({ beginIndex: _beginIndex, endIndex: _endIndex, layer: _layer, ...document }) => document),
    changeRationale: changeRationale!,
    requirementsTraceability: requirementsTraceability!,
    preservationAudit: preservationAudit!
  };
}

type ParsedSystemBlock = {
  layer: "system";
  id: "system";
  path: "instructions/system.md";
  content: string;
  beginIndex: number;
  endIndex: number;
};

type ParsedSkillBlock = CorpusSkill & {
  layer: "skill";
  beginIndex: number;
  endIndex: number;
};

type ParsedReferenceBlock = CorpusSkillReference & {
  layer: "reference";
  beginIndex: number;
  endIndex: number;
};

type ParsedKnowledgeBlock = CorpusKnowledgeDocument & {
  layer: "knowledge";
  beginIndex: number;
  endIndex: number;
};

type ParsedCorpusAssetBlock = ParsedSystemBlock | ParsedSkillBlock | ParsedReferenceBlock | ParsedKnowledgeBlock;

type MarkerMatch = {
  kind: "begin" | "content" | "end";
  index: number;
  endIndex: number;
};

function parseCorpusAssetBlocks(markdown: string, availableToolIds: Set<string>): ParsedCorpusAssetBlock[] {
  const markerExpression = /^<!-- HATCH_CORPUS_ASSET_(BEGIN|CONTENT|END) -->\r?$/gm;
  const markers: MarkerMatch[] = [...markdown.matchAll(markerExpression)].map((match) => ({
    kind: match[1]!.toLocaleLowerCase() as MarkerMatch["kind"],
    index: match.index ?? 0,
    endIndex: (match.index ?? 0) + match[0].length
  }));
  if (markers.length === 0) return [];
  if (markers.length % 3 !== 0) {
    throw new Error("Corpus compilation contains an incomplete asset marker block");
  }

  const assets: ParsedCorpusAssetBlock[] = [];
  let previousEnd = 0;
  for (let index = 0; index < markers.length; index += 3) {
    const begin = markers[index]!;
    const contentMarker = markers[index + 1]!;
    const end = markers[index + 2]!;
    if (begin.kind !== "begin" || contentMarker.kind !== "content" || end.kind !== "end") {
      throw new Error("Corpus compilation has malformed or nested asset markers");
    }
    if (assets.length > 0 && markdown.slice(previousEnd, begin.index).trim()) {
      throw new Error("Corpus compilation contains content outside an asset block before the audit envelope");
    }
    const metadata = parseAssetMetadata(markdown.slice(begin.endIndex, contentMarker.index));
    const content = markdown.slice(contentMarker.endIndex, end.index).trim();
    if (!content) throw new Error(`Corpus ${metadata.layer ?? "unknown"} asset has empty content`);
    assets.push(buildCorpusAsset(metadata, content, begin.index, end.endIndex, availableToolIds));
    previousEnd = end.endIndex;
  }

  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const asset of assets) {
    if (seenIds.has(asset.id)) throw new Error(`Corpus compilation repeats asset id: ${asset.id}`);
    if (seenPaths.has(asset.path)) throw new Error(`Corpus compilation repeats asset path: ${asset.path}`);
    seenIds.add(asset.id);
    seenPaths.add(asset.path);
  }

  if (assets[0]?.layer !== "system") throw new Error("The first Corpus asset must be the system asset");
  const layerOrder = new Map(CORPUS_ASSET_LAYERS.map((layer, index) => [layer, index]));
  for (let index = 1; index < assets.length; index += 1) {
    if (layerOrder.get(assets[index]!.layer)! < layerOrder.get(assets[index - 1]!.layer)!) {
      throw new Error("Corpus assets must be ordered as system, skills, references, then knowledge");
    }
  }

  const skillIds = new Set(assets.filter((asset) => asset.layer === "skill").map((asset) => asset.id));
  for (const reference of assets.filter((asset): asset is ParsedReferenceBlock => asset.layer === "reference")) {
    if (!skillIds.has(reference.parentSkillId)) {
      throw new Error(`Corpus reference ${reference.id} has unknown parent skill: ${reference.parentSkillId}`);
    }
  }
  return assets;
}

function parseAssetMetadata(markdown: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const match = /^([a-z][a-z0-9_]*):[ \t]*(.*)$/.exec(rawLine);
    if (!match) throw new Error(`Corpus asset metadata is malformed: ${rawLine.trim()}`);
    const [, key, rawValue] = match;
    if (Object.hasOwn(metadata, key!)) throw new Error(`Corpus asset metadata repeats field: ${key}`);
    metadata[key!] = rawValue!.trim();
  }
  return metadata;
}

function buildCorpusAsset(
  metadata: Record<string, string>,
  content: string,
  beginIndex: number,
  endIndex: number,
  availableToolIds: Set<string>
): ParsedCorpusAssetBlock {
  const layer = requireMetadata(metadata, "layer");
  if (!CORPUS_ASSET_LAYERS.includes(layer as typeof CORPUS_ASSET_LAYERS[number])) {
    throw new Error(`Corpus asset has invalid layer: ${layer}`);
  }
  const id = requireCorpusIdentifier(requireMetadata(metadata, "id"), `${layer} asset id`);

  if (layer === "system") {
    requireExactMetadataFields(metadata, ["layer", "id"]);
    if (id !== "system") throw new Error("Corpus system asset id must be system");
    return { layer, id: "system", path: "instructions/system.md", content, beginIndex, endIndex };
  }

  if (layer === "skill") {
    requireExactMetadataFields(metadata, ["layer", "id", "name", "when_to_use", "allowed_tool_ids"]);
    const name = requireMetadata(metadata, "name");
    const whenToUse = requireMetadata(metadata, "when_to_use");
    const allowedToolIds = parseAllowedToolIds(metadata.allowed_tool_ids!, id, availableToolIds);
    return {
      layer,
      id,
      path: `skills/${id}/SKILL.md`,
      name,
      whenToUse,
      allowedToolIds,
      content,
      beginIndex,
      endIndex
    };
  }

  if (layer === "reference") {
    requireExactMetadataFields(metadata, ["layer", "id", "parent_skill_id", "reference_kind"]);
    const parentSkillId = requireCorpusIdentifier(
      requireMetadata(metadata, "parent_skill_id"),
      `reference ${id} parent_skill_id`
    );
    const kind = requireMetadata(metadata, "reference_kind");
    if (!REFERENCE_KINDS.includes(kind as CorpusReferenceKind)) {
      throw new Error(`Corpus reference ${id} has invalid reference kind: ${kind}`);
    }
    return {
      layer,
      id,
      path: `skills/${parentSkillId}/references/${id}.md`,
      parentSkillId,
      kind: kind as CorpusReferenceKind,
      content,
      beginIndex,
      endIndex
    };
  }

  requireExactMetadataFields(metadata, ["layer", "id", "source_summary", "retrieval_only"]);
  const sourceSummary = requireMetadata(metadata, "source_summary");
  if (metadata.retrieval_only !== "true") {
    throw new Error(`Corpus knowledge ${id} must declare retrieval_only: true`);
  }
  return {
    layer: "knowledge",
    id,
    path: `knowledge/${id}.md`,
    sourceSummary,
    retrievalOnly: true,
    content,
    beginIndex,
    endIndex
  };
}

function requireExactMetadataFields(metadata: Record<string, string>, expected: readonly string[]): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(metadata)) {
    if (!expectedSet.has(key)) throw new Error(`Corpus asset metadata has unknown field: ${key}`);
  }
  for (const key of expected) requireMetadata(metadata, key);
}

function requireMetadata(metadata: Record<string, string>, key: string): string {
  const value = metadata[key]?.trim();
  if (!value) throw new Error(`Corpus asset metadata is missing non-empty field: ${key}`);
  return value;
}

function requireCorpusIdentifier(value: string, field: string): string {
  if (!CORPUS_IDENTIFIER.test(value)) {
    throw new Error(`${field} must be a lowercase Agent Corpus identifier`);
  }
  return value;
}

function validateAvailableToolIds(values: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    if (!TOOL_IDENTIFIER.test(value)) throw new Error(`Available tool id is invalid: ${value}`);
    if (result.has(value)) throw new Error(`Available tool ids contain a duplicate: ${value}`);
    result.add(value);
  }
  return result;
}

function parseAllowedToolIds(value: string, skillId: string, availableToolIds: Set<string>): string[] {
  if (value === "[]") return [];
  const ids = value.split(",").map((item) => item.trim());
  if (ids.some((item) => !item)) {
    throw new Error(`Corpus skill ${skillId} has malformed allowed_tool_ids`);
  }
  const result = new Set<string>();
  for (const id of ids) {
    if (!TOOL_IDENTIFIER.test(id)) throw new Error(`Corpus skill ${skillId} has invalid tool id: ${id}`);
    if (result.has(id)) throw new Error(`Corpus skill ${skillId} repeats allowed tool id: ${id}`);
    if (!availableToolIds.has(id)) throw new Error(`Corpus skill ${skillId} references unavailable tool id: ${id}`);
    result.add(id);
  }
  return [...result];
}

/** Ensures a readable audit explicitly accounts for every revision disposition. */
export function validatePreservationAudit(markdown: string): void {
  const headings = PRESERVATION_AUDIT_SECTIONS.map((title) => {
    const matches = headingMatches(markdown, 2, title);
    if (matches.length !== 1) {
      throw new Error(`Preservation audit must contain exactly one ## ${title} section`);
    }
    return matches[0]!;
  });
  for (let index = 1; index < headings.length; index += 1) {
    if (headings[index]!.index <= headings[index - 1]!.index) {
      throw new Error(`Preservation audit sections are out of order near ## ${PRESERVATION_AUDIT_SECTIONS[index]}`);
    }
  }
  for (let index = 0; index < headings.length; index += 1) {
    const match = headings[index]!;
    const start = match.index + match.text.length;
    const end = headings[index + 1]?.index ?? markdown.length;
    if (!markdown.slice(start, end).trim()) {
      throw new Error(`Preservation audit has no content under ## ${PRESERVATION_AUDIT_SECTIONS[index]}`);
    }
  }
}

function requireCompilationBody(title: string, body: string | undefined): asserts body is string {
  if (!body?.trim()) throw new Error(`Corpus compilation has no content under # ${title}`);
}

function topLevelHeadingMatches(markdown: string, title: string): Array<{ index: number; text: string }> {
  return headingMatches(markdown, 1, title);
}

function headingMatches(markdown: string, level: number, title: string): Array<{ index: number; text: string }> {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`^#{${level}}[ \\t]+${escaped}[ \\t]*\\r?$`, "gim");
  return [...markdown.matchAll(expression)].map((match) => ({
    index: match.index ?? 0,
    text: match[0]
  }));
}

function namedSection(markdown: string, title: string, followingTitles: string[]): string {
  const match = heading(markdown, title);
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const endings = followingTitles.flatMap((following) => {
    const next = heading(rest, following);
    return next?.index === undefined ? [] : [next.index];
  });
  const end = endings.length > 0 ? Math.min(...endings) : rest.length;
  return rest.slice(0, end).trim();
}

function tailSection(markdown: string, title: string): string {
  const match = heading(markdown, title);
  if (!match || match.index === undefined) return "";
  return markdown.slice(match.index + match[0].length).trim();
}

function heading(markdown: string, title: string): RegExpExecArray | null {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^#{1,4}\\s+${escaped}\\s*$`, "im").exec(markdown);
}

export function section(markdown: string, title: string): string {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^#{1,3}\\s+${escaped}\\s*$`, "im");
  const match = pattern.exec(markdown);
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const nextHeading = /^#{1,3}\s+.+$/m.exec(rest);
  return rest.slice(0, nextHeading?.index ?? rest.length).trim();
}

function questionBlock(markdown: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startPattern = new RegExp(`^##\\s+${escaped}(?:\\s*[-—:].*)?\\s*$`, "im");
  const start = startPattern.exec(markdown);
  if (!start || start.index === undefined) return "";
  const rest = markdown.slice(start.index + start[0].length);
  const next = /^##\s+(?:[A-Za-z][\w-]*\.)?Q\d+/m.exec(rest);
  return rest.slice(0, next?.index ?? rest.length);
}

function firstContentBlock(markdown: string): string {
  return markdown
    .replace(/^#{1,4}\s+.*$/gm, "")
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .find(Boolean) ?? "";
}
