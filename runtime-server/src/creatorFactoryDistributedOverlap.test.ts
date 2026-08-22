import assert from "node:assert/strict";
import test from "node:test";
import type { CorpusCompilation } from "./creatorLearning/markdown.js";
import { auditRawSourceOverlap } from "./creatorLearning/corpusReleaseGuards.js";

const RAW_SOURCE_ID = "PRIVATE-DISTRIBUTED";
const PROTECTED_SOURCE = [
  "cobaltlanternseventhstair",
  "amberledgerquietreviewer",
  "irreversibletradeoffowner",
  "observablesignalreopeningdecision"
].join("");

test("raw source split verbatim across four sub-80-character assets fails closed", () => {
  const protectedWindow = PROTECTED_SOURCE.slice(0, 80);
  const fragments = fourFragments(protectedWindow);
  assert.equal(fragments.every((fragment) => normalizedLength(fragment) < 80), true);

  const violations = auditRawSourceOverlap(compilationWithFourAssets(fragments), [{
    id: RAW_SOURCE_ID,
    authority: "private_material",
    title: "Private distributed protocol",
    content: PROTECTED_SOURCE
  }]);

  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.code, "raw_source_overlap");
  assert.equal(violations[0]!.sourceId, RAW_SOURCE_ID);
  assert.deepEqual(violations[0]!.assetPath.split(", "), [
    "instructions/system.md",
    "knowledge/slice-four.md",
    "skills/slice-two/SKILL.md",
    "skills/slice-two/references/slice-three.md"
  ]);
  assert.match(violations[0]!.detail, /witness: distributed_exact_16_character_fragments/);
  assert.match(violations[0]!.detail, /source_window: \[0,80\)/);
  assert.match(violations[0]!.detail, /matched_normalized_characters: 80\/80/);
  for (const fragment of fragments) assert.equal(violations[0]!.detail.includes(fragment), false);
});

test("distributed overlap ignores asset order and Markdown headings", () => {
  const fragments = fourFragments(PROTECTED_SOURCE.slice(0, 80));
  const shuffledAndWrapped = [
    `# Final signal\n\n${fragments[3]}`,
    `## Opening constraint\n\n${fragments[0]}`,
    `### Review rule\n\n${fragments[2]}`,
    `# Evidence ledger\n\n${fragments[1]}`
  ];
  assert.equal(shuffledAndWrapped.every((fragment) => normalizedLength(fragment) < 80), true);

  const violations = auditRawSourceOverlap(compilationWithFourAssets(shuffledAndWrapped), [{
    id: RAW_SOURCE_ID,
    authority: "creator_current",
    title: "Current creator protocol",
    content: PROTECTED_SOURCE
  }]);

  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.code, "raw_source_overlap");
  assert.equal(violations[0]!.sourceId, RAW_SOURCE_ID);
  assert.equal(violations[0]!.assetPath.split(", ").length, 4);
});

test("a repeated short framework term across assets remains below the distributed protection floor", () => {
  const source = [
    "In the private workshop the phrase North Star Delta names the framework.",
    "The protected example instead describes copper markers, renewal evidence,",
    "a dissenting reviewer, and an irreversible quarterly commitment."
  ].join(" ");
  const compilation = compilationWithFourAssets([
    "# Direction\n\nUse North Star Delta.",
    "# Checklist\n\nApply North Star Delta when the decision is material.",
    "# Delivery\n\nReturn a decisive and usable recommendation.",
    "# Boundaries\n\nState uncertainty without inventing facts."
  ]);

  assert.deepEqual(auditRawSourceOverlap(compilation, [{
    id: "PRIVATE-FRAMEWORK-NAME",
    authority: "private_material",
    title: "Internal framework workshop",
    content: source
  }]), []);
});

test("an exact 80-character copy still fails the direct detector", () => {
  const copied = PROTECTED_SOURCE.slice(0, 80);
  const violations = auditRawSourceOverlap(compilationWithContentAssets([
    copied,
    "A separate synthesized instruction keeps this compilation structurally distributed."
  ]), [rawSource()]);

  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.code, "raw_source_overlap");
  assert.equal(violations[0]!.assetPath, "instructions/system.md");
  assert.match(violations[0]!.detail, /witness: exact_normalized_span/);
  assert.match(violations[0]!.detail, /source_range: \[0,80\)/);
  assert.match(violations[0]!.detail, /candidate_range: \[0,80\)/);
  assert.equal(violations[0]!.detail.includes(copied), false);
});

test("sixteen-character fingerprints reconstructed across fields above 60 characters fail closed", () => {
  const protectedWindow = PROTECTED_SOURCE.slice(0, 64);
  const fragments = Array.from({ length: 4 }, (_, index) => (
    protectedWindow.slice(index * 16, index * 16 + 16)
  ));
  assert.equal(fragments.every((fragment) => normalizedLength(fragment) === 16), true);

  const violations = auditRawSourceOverlap(compilationWithContentAssets(fragments), [rawSource()]);

  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.code, "raw_source_overlap");
  assert.equal(violations[0]!.sourceId, RAW_SOURCE_ID);
  assert.equal(violations[0]!.assetPath.split(", ").length, 4);
  for (const fragment of fragments) assert.equal(violations[0]!.detail.includes(fragment), false);
});

test("distributed source-window coverage boundary is exactly 60 of 80 characters", () => {
  const firstForty = [PROTECTED_SOURCE.slice(0, 20), PROTECTED_SOURCE.slice(20, 40)];
  const sixtyCharacters = [...firstForty, PROTECTED_SOURCE.slice(40, 60)];
  const fiftyNineCharacters = [...firstForty, PROTECTED_SOURCE.slice(40, 59)];

  assert.equal(auditRawSourceOverlap(compilationWithContentAssets(sixtyCharacters), [rawSource()]).length, 1);
  assert.deepEqual(auditRawSourceOverlap(compilationWithContentAssets(fiftyNineCharacters), [rawSource()]), []);
});

test("fifteen-character chunks are the declared distributed detection boundary", () => {
  const chunks = Array.from({ length: 5 }, (_, index) => (
    PROTECTED_SOURCE.slice(index * 15, index * 15 + 15)
  ));
  assert.equal(chunks.every((chunk) => normalizedLength(chunk) === 15), true);
  assert.deepEqual(auditRawSourceOverlap(compilationWithContentAssets(chunks), [rawSource()]), []);
});

test("raw prose in every LLM-authored manifest metadata kind is protected", async (t) => {
  const cases: Array<{
    name: string;
    expectedPath: string;
    compilation: CorpusCompilation;
  }> = [
    {
      name: "skill name",
      expectedPath: "agent.json#skills/metadata-skill/name",
      compilation: compilationWithMetadata({ skillName: PROTECTED_SOURCE })
    },
    {
      name: "skill when-to-use",
      expectedPath: "agent.json#skills/metadata-skill/when_to_use",
      compilation: compilationWithMetadata({ whenToUse: PROTECTED_SOURCE })
    },
    {
      name: "knowledge title",
      expectedPath: "agent.json#knowledge/metadata-knowledge/title",
      compilation: compilationWithMetadata({ title: PROTECTED_SOURCE })
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const violations = auditRawSourceOverlap(fixture.compilation, [rawSource()]);
      assert.equal(violations.length, 1);
      assert.equal(violations[0]!.code, "raw_source_overlap");
      assert.equal(violations[0]!.assetPath, fixture.expectedPath);
      assert.equal(violations[0]!.detail.includes(PROTECTED_SOURCE), false);
    });
  }
});

test("one candidate phrase occurrence is not projected onto every periodic source occurrence", () => {
  const phrase = "northstardeltaxx";
  const periodicSource = phrase.repeat(5);
  const compilation = compilationWithContentAssets([
    phrase,
    phrase
  ]);

  assert.deepEqual(auditRawSourceOverlap(compilation, [{
    id: "PRIVATE-PERIODIC-ONE-OCCURRENCE",
    authority: "private_material",
    title: "Periodic private source",
    content: periodicSource
  }]), []);
});

test("periodic common-English fingerprints stay below the unique-occurrence coverage threshold", () => {
  const phrase = "thecustomerneeds";
  assert.equal(phrase.length, 16);
  const periodicSource = `${phrase.repeat(20)} quarterly planning evidence and review context`;
  const compilation = compilationWithContentAssets([
    phrase,
    phrase,
    "Choose a practical recommendation from the user's current facts."
  ]);

  assert.deepEqual(auditRawSourceOverlap(compilation, [{
    id: "PUBLIC-COMMON-PERIODIC",
    authority: "public_context",
    title: "Periodic common-English corpus",
    content: periodicSource
  }]), []);
});

test("independent candidate occurrences can reconstruct a periodic protected window", () => {
  const phrase = "northstardeltaxx";
  const periodicSource = phrase.repeat(5);
  const compilation = compilationWithContentAssets(Array.from({ length: 4 }, () => phrase));

  const violations = auditRawSourceOverlap(compilation, [{
    id: "PRIVATE-PERIODIC-MANY-OCCURRENCES",
    authority: "private_material",
    title: "Periodic private source",
    content: periodicSource
  }]);

  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.code, "raw_source_overlap");
  assert.equal(violations[0]!.assetPath.split(", ").length, 4);
});

test("overlapping maximal matches are trimmed instead of hiding position-unique coverage", () => {
  const x = "甲".repeat(20);
  const y = "乙".repeat(20);
  const z = "丙".repeat(20);
  const source = x + y + y + z;
  const compilation = compilationWithContentAssets([
    x + y + z,
    y.slice(0, 16)
  ]);

  const violations = auditRawSourceOverlap(compilation, [{
    id: "PRIVATE-OVERLAPPING-MAXIMAL-SPANS",
    authority: "private_material",
    title: "Overlapping source alignments",
    content: source
  }]);

  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.code, "raw_source_overlap");
  assert.deepEqual(violations[0]!.assetPath.split(", "), [
    "instructions/system.md",
    "knowledge/slice-2.md"
  ]);
});

test("distributed anchor-pair budget exhaustion rejects without echoing raw prose", () => {
  const phrase = "abcdefghijklmnop";
  const source = phrase.repeat(40);
  const compilation = compilationWithContentAssets(Array.from({ length: 100 }, () => phrase.repeat(4)));

  const violations = auditRawSourceOverlap(compilation, [{
    id: "PRIVATE-DISTRIBUTED-BUDGET",
    authority: "private_material",
    title: "Adversarial periodic source",
    content: source
  }]);

  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.code, "raw_source_overlap_inconclusive");
  assert.match(violations[0]!.detail, /analysis: inconclusive \(anchor pair budget exceeded\); deterministic recheck required/i);
  assert.equal(violations[0]!.detail.includes(source), false);
  assert.equal(violations[0]!.detail.includes(phrase.repeat(6)), false);
});

test("distributed unique-span budget exhaustion rejects without raw output", () => {
  const fragment = "qzvxjbdkfhwcmptr";
  const source = fragment + "甲".repeat(100);
  const compilation = compilationWithRepeatedContentAssets(20_001, fragment);

  const violations = auditRawSourceOverlap(compilation, [{
    id: "PRIVATE-DISTRIBUTED-SPAN-BUDGET",
    authority: "private_material",
    title: "Adversarial field fanout",
    content: source
  }]);

  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.code, "raw_source_overlap_inconclusive");
  assert.match(violations[0]!.detail, /analysis: inconclusive \(match span budget exceeded\); deterministic recheck required/i);
  assert.equal(violations[0]!.detail.includes(source), false);
});

test("distributed position-matching budget exhaustion fails closed", () => {
  const source = ("a".repeat(29) + "b".repeat(51)).repeat(75);
  const compilation = compilationWithContentAssets([
    "a".repeat(30),
    "b".repeat(30)
  ]);

  const violations = auditRawSourceOverlap(compilation, [{
    id: "PRIVATE-DISTRIBUTED-POSITION-BUDGET",
    authority: "private_material",
    title: "Adversarial Hall-deficient alignments",
    content: source
  }]);

  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.code, "raw_source_overlap_inconclusive");
  assert.match(violations[0]!.detail, /analysis: inconclusive \(position search budget exceeded\); deterministic recheck required/i);
  assert.equal(violations[0]!.detail.includes(source.slice(0, 80)), false);
});

test("a 100KB same-topic archive does not make distributed synthesis look like raw reconstruction", () => {
  const source = Array.from({ length: 900 }, (_, index) => [
    `Market note ${index}: subscription teams compare retention evidence, pricing pressure, implementation effort, and reversible experiments before quarterly planning.`,
    `公開メモ${index}：継続率の証拠、価格への圧力、導入負荷、検証可能な実験を四半期計画の前に比較する。`
  ].join(" ")).join("\n");
  assert.ok(Buffer.byteLength(source, "utf8") > 100_000);
  const compilation = compilationWithContentAssets([
    "Prioritize the user's present constraint and state one recommendation.",
    "Compare acting now with waiting, and make reversibility explicit.",
    "Adapt the tone, examples, and delivery to the intended audience.",
    "Finish with publishable copy instead of a broad survey of options."
  ]);

  assert.deepEqual(auditRawSourceOverlap(compilation, [{
    id: "PUBLIC-LONG-DISTRIBUTED",
    authority: "public_context",
    title: "Large bilingual market archive",
    content: source
  }]), []);
});

function fourFragments(value: string): string[] {
  assert.equal(value.length, 80);
  return [0, 20, 40, 60].map((start) => value.slice(start, start + 20));
}

function normalizedLength(value: string): number {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").length;
}

function compilationWithFourAssets(contents: readonly string[]): CorpusCompilation {
  assert.equal(contents.length, 4);
  return {
    format: "layered-assets",
    systemInstructions: contents[0]!,
    skills: [{
      id: "slice-two",
      path: "skills/slice-two/SKILL.md",
      name: "Slice two",
      whenToUse: "When applying the creator method",
      allowedToolIds: [],
      content: contents[1]!
    }],
    references: [{
      id: "slice-three",
      path: "skills/slice-two/references/slice-three.md",
      parentSkillId: "slice-two",
      kind: "method",
      content: contents[2]!
    }],
    knowledge: [{
      id: "slice-four",
      path: "knowledge/slice-four.md",
      title: "Creator-authorized material",
      retrievalOnly: true,
      content: contents[3]!
    }],
    changeRationale: "Test fixture",
    requirementsTraceability: "Test fixture",
    preservationAudit: "Test fixture"
  };
}

function compilationWithContentAssets(contents: readonly string[]): CorpusCompilation {
  assert.ok(contents.length >= 2);
  return {
    format: "layered-assets",
    systemInstructions: contents[0]!,
    skills: [],
    references: [],
    knowledge: contents.slice(1).map((content, index) => ({
      id: `slice-${index + 2}`,
      path: `knowledge/slice-${index + 2}.md`,
      title: `Synthesized summary ${index + 2}`,
      retrievalOnly: true,
      content
    })),
    changeRationale: "Test fixture",
    requirementsTraceability: "Test fixture",
    preservationAudit: "Test fixture"
  };
}

function compilationWithMetadata(overrides: {
  skillName?: string;
  whenToUse?: string;
  title?: string;
}): CorpusCompilation {
  return {
    format: "layered-assets",
    systemInstructions: "Choose a direction and make the result usable.",
    skills: [{
      id: "metadata-skill",
      path: "skills/metadata-skill/SKILL.md",
      name: overrides.skillName ?? "Decisive synthesis",
      whenToUse: overrides.whenToUse ?? "When a consequential recommendation is required",
      allowedToolIds: [],
      content: "Apply evidence, make the tradeoff explicit, and deliver the result."
    }],
    references: [],
    knowledge: [{
      id: "metadata-knowledge",
      path: "knowledge/metadata-knowledge.md",
      title: overrides.title ?? "A synthesized decision method",
      retrievalOnly: true,
      content: "Retrieve this when the user needs a grounded example."
    }],
    changeRationale: "Test fixture",
    requirementsTraceability: "Test fixture",
    preservationAudit: "Test fixture"
  };
}

function compilationWithRepeatedContentAssets(count: number, content: string): CorpusCompilation {
  assert.ok(count >= 2);
  return {
    format: "layered-assets",
    systemInstructions: content,
    skills: [],
    references: [],
    knowledge: Array.from({ length: count - 1 }, (_, index) => ({
      id: `repeated-${index + 2}`,
      path: `knowledge/repeated-${index + 2}.md`,
      title: "safe",
      retrievalOnly: true,
      content
    })),
    changeRationale: "Test fixture",
    requirementsTraceability: "Test fixture",
    preservationAudit: "Test fixture"
  };
}

function rawSource() {
  return {
    id: RAW_SOURCE_ID,
    authority: "private_material" as const,
    title: "Private distributed protocol",
    content: PROTECTED_SOURCE
  };
}
