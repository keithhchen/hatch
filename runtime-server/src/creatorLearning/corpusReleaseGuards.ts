import type { CorpusCompilation } from "./markdown.js";
import type { FactoryStartInput } from "./types.js";

export type CorpusReleaseGuardViolation = {
  code:
    | "asset_removed"
    | "asset_materially_shortened"
    | "system_section_removed"
    | "raw_source_overlap"
    | "raw_source_overlap_inconclusive";
  assetPath: string;
  detail: string;
  sourceId?: string;
};

export type RawCorpusSource = FactoryStartInput["sources"][number];

const MATERIAL_LENGTH_RATIO = 0.7;
const OVERLAP_SHINGLE_CHARACTERS = 8;
// A distributed finding needs document-fingerprint evidence, not the noise-floor
// coincidences produced by four-character language fragments. Sixteen normalized
// characters is the declared exact-fragment boundary for the order-free detector;
// direct exact/near-verbatim protection remains independently anchored at 80.
const DISTRIBUTED_FRAGMENT_CHARACTERS = 16;
const MINIMUM_PROTECTED_SPAN_CHARACTERS = 80;
const MINIMUM_DISTRIBUTED_COVERAGE_CHARACTERS = 60;
const MAXIMUM_NEAR_VERBATIM_WINDOW_CHARACTERS = 240;
const NEAR_VERBATIM_SHINGLE_COVERAGE = 0.74;
const MAXIMUM_ALIGNMENT_DRIFT_CHARACTERS = 24;
const MAXIMUM_ANCHOR_POSITIONS = 32;
// Occurrence expansion and the exact position-consumption search are both
// explicitly bounded. Exhausting either budget rejects the release as
// inconclusive; it never silently turns an expensive source into a pass.
const MAX_DISTRIBUTED_MATCH_SPANS = 20_000;
const MAX_DISTRIBUTED_ANCHOR_PAIRS = MAX_DISTRIBUTED_MATCH_SPANS * 8;
const MAX_DISTRIBUTED_DP_STATES = 200_000;

/**
 * V1 is deliberately stricter than the prose preservation audit: an audit is
 * useful feedback for the next compiler call, but is never authorization to
 * delete or materially shrink an already accepted cognitive asset.
 */
export function auditCompilationContinuity(
  accepted: readonly CorpusCompilation[],
  candidate: CorpusCompilation
): CorpusReleaseGuardViolation[] {
  if (accepted.length === 0) return [];

  const violations: CorpusReleaseGuardViolation[] = [];
  const currentAssets = new Map(cognitiveAssets(candidate).map((asset) => [asset.path, asset]));
  const highWaterAssets = new Map<string, { semanticSize: number }>();
  const protectedSystemHeadings = new Map<string, string>();
  for (const compilation of accepted) {
    for (const asset of cognitiveAssets(compilation)) {
      const size = semanticSize(asset.content);
      const current = highWaterAssets.get(asset.path);
      if (!current || size > current.semanticSize) {
        highWaterAssets.set(asset.path, { semanticSize: size });
      }
    }
    for (const heading of markdownHeadings(compilation.systemInstructions)) {
      protectedSystemHeadings.set(normalizeComparableText(heading), heading);
    }
  }

  for (const [assetPath, baseline] of highWaterAssets) {
    const replacement = currentAssets.get(assetPath);
    if (!replacement) {
      violations.push({
        code: "asset_removed",
        assetPath,
        detail: `Previously accepted asset ${assetPath} is absent; V1 revisions cannot delete or rename assets.`
      });
      continue;
    }

    const previousSize = baseline.semanticSize;
    const candidateSize = semanticSize(replacement.content);
    if (previousSize > 0 && candidateSize < Math.floor(previousSize * MATERIAL_LENGTH_RATIO)) {
      violations.push({
        code: "asset_materially_shortened",
        assetPath,
        detail: `Previously accepted asset ${assetPath} retained ${candidateSize}/${previousSize} semantic characters against its accepted high-water baseline; V1 requires at least ${Math.round(MATERIAL_LENGTH_RATIO * 100)}%.`
      });
    }
  }

  const candidateSystemHeadings = new Set(markdownHeadings(candidate.systemInstructions).map(normalizeComparableText));
  for (const [normalizedHeading, heading] of protectedSystemHeadings) {
    if (!candidateSystemHeadings.has(normalizedHeading)) {
      violations.push({
        code: "system_section_removed",
        assetPath: "instructions/system.md",
        detail: `Previously accepted System section is absent from the revision: ${singleLine(heading)}`
      });
    }
  }

  return violations;
}

/**
 * Rejects raw-source reproduction in every publishable cognitive layer. This
 * is intentionally authority-agnostic: private/current material is always
 * protected, and examples/public context are not treated as copy licenses.
 * Short names and framework terms remain below the protected-span floor.
 */
export function auditRawSourceOverlap(
  candidate: CorpusCompilation,
  sources: readonly RawCorpusSource[]
): CorpusReleaseGuardViolation[] {
  const violations: CorpusReleaseGuardViolation[] = [];
  const fields = publishableLlmFields(candidate).map((field, index) => ({
    ...field,
    index,
    normalizedContent: normalizeComparableText(field.content)
  }));
  const candidateShingleSet = new Set<string>();
  for (const field of fields) {
    if (field.normalizedContent.length < MINIMUM_PROTECTED_SPAN_CHARACTERS) continue;
    for (const shingle of orderedCharacterShingles(field.normalizedContent, OVERLAP_SHINGLE_CHARACTERS)) {
      candidateShingleSet.add(shingle);
    }
  }

  for (const source of sources) {
    const normalizedSource = normalizeComparableText(source.content);
    if (normalizedSource.length < MINIMUM_PROTECTED_SPAN_CHARACTERS) continue;
    const sourceExactHashes = rollingHashes(normalizedSource, MINIMUM_PROTECTED_SPAN_CHARACTERS);
    const sourcePositions = sourcePositionsForCandidateShingles(
      normalizedSource,
      candidateShingleSet,
      OVERLAP_SHINGLE_CHARACTERS
    );
    let sourceAlreadyRejected = false;

    for (const field of fields) {
      const normalizedField = field.normalizedContent;
      if (normalizedField.length < MINIMUM_PROTECTED_SPAN_CHARACTERS) continue;
      const overlap = findRawOverlap(normalizedField, normalizedSource, sourceExactHashes, sourcePositions);
      if (!overlap) continue;
      sourceAlreadyRejected = true;
      violations.push({
        code: "raw_source_overlap",
        assetPath: field.path,
        sourceId: source.id,
        detail: [
          `paths: ${field.path}; source_id: ${singleLine(source.id)};`,
          `witness: ${overlap.kind};`,
          `source_range: ${formatNormalizedRange(overlap.sourceRange)};`,
          `candidate_range: ${formatNormalizedRange(overlap.candidateRange)};`,
          overlap.kind === "exact_normalized_span"
            ? `matched_normalized_characters: ${overlap.candidateRange.end - overlap.candidateRange.start}`
            : `ordered_shingle_coverage: ${percentage(overlap.coverage)}`
        ].join(" ")
      });
    }

    // A direct violation already fails this source closed. Avoid emitting a
    // redundant distributed finding whose contributors merely include that
    // same long asset; the aggregate detector exists to close the short-asset
    // splitting bypass left by the per-asset 80-character floor.
    if (sourceAlreadyRejected) continue;
    const distributedOverlap = findDistributedRawOverlap(
      normalizedSource,
      fields
    );
    if (!distributedOverlap) continue;
    const joinedPaths = distributedOverlap.contributorPaths.join(", ");
    violations.push({
      code: distributedOverlap.inconclusive
        ? "raw_source_overlap_inconclusive"
        : "raw_source_overlap",
      assetPath: joinedPaths,
      sourceId: source.id,
      // Position-only witness metadata is safe to persist and sufficient to
      // audit the finding. Raw text and Markdown headings are never echoed.
      detail: distributedOverlap.inconclusive
        ? `inspected_paths: ${joinedPaths}; source_id: ${singleLine(source.id)}; analysis: inconclusive (${distributedOverlap.reason}); deterministic recheck required`
        : formatDistributedWitness(distributedOverlap, source.id)
    });
  }

  return violations;
}

/** Reconstructs the losslessly line-numbered packet written by CreatorFactory. */
export function parseRawSourcesFromPacket(packet: string): RawCorpusSource[] {
  // The renderer owns this exact single-space framing. Matching it exactly is
  // what lets legitimate filename whitespace (and non-ASCII whitespace such
  // as U+FEFF/NBSP) remain data rather than being consumed as presentation.
  const header = /^## ([^\n]+?) — ([^\n]*)\n\nAuthority: (creator_current|creator_example|private_material|public_context)\n/gm;
  const matches = [...packet.matchAll(header)];
  if (matches.length === 0) throw new Error("Authorized source packet contains no parseable sources");

  return matches.map((match, index) => {
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? packet.length;
    const bodyLines = packet.slice(bodyStart, bodyEnd).split("\n");
    while (bodyLines[0] === "") bodyLines.shift();
    while (bodyLines.at(-1) === "") bodyLines.pop();
    const contentLines: string[] = [];
    for (let lineIndex = 0; lineIndex < bodyLines.length; lineIndex += 1) {
      const prefix = `L${lineIndex + 1}: `;
      const numbered = bodyLines[lineIndex]!;
      if (!numbered.startsWith(prefix)) {
        throw new Error(`Authorized source packet is malformed near source ${singleLine(match[1]!)}`);
      }
      // Slice by an exact structural prefix rather than `.*`: JavaScript dot
      // excludes CR/U+2028/U+2029, all of which are valid source code units
      // that must survive the reversible packet unchanged.
      contentLines.push(numbered.slice(prefix.length));
    }
    const id = match[1]!;
    const title = match[2]!;
    const authority = match[3] as RawCorpusSource["authority"];
    if (!id || !title || contentLines.length === 0) {
      throw new Error("Authorized source packet contains an incomplete source");
    }
    return { id, title, authority, content: contentLines.join("\n") };
  });
}

type NormalizedRange = { start: number; end: number };

type DirectOverlap = {
  kind: "exact_normalized_span";
  candidateRange: NormalizedRange;
  sourceRange: NormalizedRange;
} | {
  kind: "ordered_identical_8_character_shingles";
  candidateRange: NormalizedRange;
  sourceRange: NormalizedRange;
  coverage: number;
};

function findRawOverlap(
  candidate: string,
  source: string,
  sourceExactHashes: ReadonlySet<number>,
  sourcePositions: ReadonlyMap<string, readonly number[]>
): DirectOverlap | undefined {
  const exact = findExactProtectedSpan(candidate, source, sourceExactHashes);
  if (exact) return { kind: "exact_normalized_span", ...exact };

  const candidateShingles = orderedCharacterShingles(candidate, OVERLAP_SHINGLE_CHARACTERS);
  const possibleMatchPrefix = new Uint32Array(candidateShingles.length + 1);
  for (let index = 0; index < candidateShingles.length; index += 1) {
    possibleMatchPrefix[index + 1] = possibleMatchPrefix[index]! + (sourcePositions.has(candidateShingles[index]!) ? 1 : 0);
  }

  for (const windowCharacters of nearVerbatimWindowSizes(candidate.length, source.length)) {
    const windowShingles = windowCharacters - OVERLAP_SHINGLE_CHARACTERS + 1;
    for (const windowStart of windowStarts(candidate.length, windowCharacters)) {
      const windowEnd = windowStart + windowShingles;
      const possibleCoverage = (
        possibleMatchPrefix[windowEnd]! - possibleMatchPrefix[windowStart]!
      ) / windowShingles;
      // The unordered count is only a cheap prefilter. A rejection below
      // requires the same shingles to appear locally and monotonically.
      if (possibleCoverage < NEAR_VERBATIM_SHINGLE_COVERAGE) continue;
      const anchor = rarestWindowAnchor(candidateShingles, sourcePositions, windowStart, windowEnd);
      if (!anchor) continue;
      for (const sourceAnchor of sampledPositions(anchor.positions, MAXIMUM_ANCHOR_POSITIONS)) {
        const sourceWindowStart = sourceAnchor - (anchor.candidateIndex - windowStart);
        const matched = orderedLocalCoverage(
          candidateShingles,
          sourcePositions,
          windowStart,
          windowEnd,
          sourceWindowStart
        );
        if (matched.coverage >= NEAR_VERBATIM_SHINGLE_COVERAGE && matched.sourceRange) {
          return {
            kind: "ordered_identical_8_character_shingles",
            candidateRange: { start: windowStart, end: windowStart + windowCharacters },
            sourceRange: matched.sourceRange,
            coverage: matched.coverage
          };
        }
      }
    }
  }
  return undefined;
}

type PublishableLlmField = {
  index: number;
  path: string;
  normalizedContent: string;
};

type DistributedMatchSpan = {
  fieldIndex: number;
  path: string;
  candidateStart: number;
  candidateEnd: number;
  sourceStart: number;
  sourceEnd: number;
};

type DistributedMatchWitness = {
  contributorPaths: string[];
  inconclusive?: false;
  matchedCharacters: number;
  sourceWindow: NormalizedRange;
  sourceRanges: NormalizedRange[];
  candidateRanges: Array<{ path: string; ranges: NormalizedRange[] }>;
};

type DistributedInconclusive = {
  contributorPaths: string[];
  inconclusive: true;
  reason: "anchor pair budget exceeded" | "match span budget exceeded" | "position search budget exceeded";
};

type DistributedOverlap = DistributedMatchWitness | DistributedInconclusive;

type DistributedMatchBuild = {
  spans?: DistributedMatchSpan[];
  inconclusive?: DistributedOverlap;
};

/**
 * Detects a protected source window reconstructed across multiple publishable
 * fields. Unlike a presence-only shingle union, every match is an aligned
 * source/candidate occurrence. A candidate character and a source character
 * can each be consumed at most once by the bounded search, so one short phrase
 * cannot be projected onto every repetition of that phrase in a source.
 *
 * Exact fragments shorter than sixteen normalized characters are deliberately
 * outside this order-free detector's evidentiary boundary: without source
 * order or lineage, short/common language fragments cannot be
 * distinguished from reconstruction without rejecting unrelated language.
 */
function findDistributedRawOverlap(
  source: string,
  fields: readonly PublishableLlmField[]
): DistributedOverlap | undefined {
  if (source.length < MINIMUM_PROTECTED_SPAN_CHARACTERS) return undefined;
  const eligible = fields.filter((field) => (
    field.normalizedContent.length >= DISTRIBUTED_FRAGMENT_CHARACTERS
  ));
  if (eligible.length < 2) return undefined;

  const built = buildDistributedMatchSpans(source, eligible);
  if (built.inconclusive) return built.inconclusive;
  const spans = built.spans ?? [];
  if (spans.length < 2) return undefined;

  const maximumWindowStart = source.length - MINIMUM_PROTECTED_SPAN_CHARACTERS;
  const spanBuckets = new Map<number, DistributedMatchSpan[]>();
  const sourceCoverageDelta = new Int32Array(source.length + 1);
  for (const span of spans) {
    sourceCoverageDelta[span.sourceStart] = sourceCoverageDelta[span.sourceStart]! + 1;
    sourceCoverageDelta[span.sourceEnd] = sourceCoverageDelta[span.sourceEnd]! - 1;
    const bucket = Math.floor(span.sourceStart / MINIMUM_PROTECTED_SPAN_CHARACTERS);
    const current = spanBuckets.get(bucket);
    if (current) current.push(span);
    else spanBuckets.set(bucket, [span]);
  }

  const requiredCoverage = MINIMUM_DISTRIBUTED_COVERAGE_CHARACTERS;
  // A linear union-coverage prepass avoids doing position matching for every
  // repeated same-topic phrase in a large archive. It is also complete: every
  // integer 80-character source window that could reach 60 covered positions
  // is considered, rather than only a sample of span endpoints.
  const sourcePositionCovered = new Uint8Array(source.length);
  let activeSpans = 0;
  for (let position = 0; position < source.length; position += 1) {
    activeSpans += sourceCoverageDelta[position]!;
    if (activeSpans > 0) sourcePositionCovered[position] = 1;
  }
  let windowCoverage = 0;
  for (let position = 0; position < MINIMUM_PROTECTED_SPAN_CHARACTERS; position += 1) {
    windowCoverage += sourcePositionCovered[position]!;
  }
  const searchBudget = { states: 0 };
  for (let windowStart = 0; windowStart <= maximumWindowStart; windowStart += 1) {
    const windowEnd = windowStart + MINIMUM_PROTECTED_SPAN_CHARACTERS;
    if (windowStart > 0) {
      windowCoverage -= sourcePositionCovered[windowStart - 1]!;
      windowCoverage += sourcePositionCovered[windowEnd - 1]!;
    }
    if (windowCoverage < requiredCoverage) continue;
    const relevantSpans: DistributedMatchSpan[] = [];
    const firstBucket = Math.floor(Math.max(0, windowStart - MINIMUM_PROTECTED_SPAN_CHARACTERS + 1)
      / MINIMUM_PROTECTED_SPAN_CHARACTERS);
    const finalBucket = Math.floor((windowEnd - 1) / MINIMUM_PROTECTED_SPAN_CHARACTERS);
    for (let bucket = firstBucket; bucket <= finalBucket; bucket += 1) {
      for (const span of spanBuckets.get(bucket) ?? []) {
        searchBudget.states += 1;
        if (searchBudget.states > MAX_DISTRIBUTED_DP_STATES) {
          return inconclusiveDistributedOverlap(
            eligible.map((field) => field.path),
            "position search budget exceeded"
          );
        }
        if (span.sourceEnd > windowStart && span.sourceStart < windowEnd) relevantSpans.push(span);
      }
    }
    if (new Set(relevantSpans.map((span) => span.path)).size < 2) continue;
    if (candidateCoverageUpperBound(relevantSpans, windowStart, windowEnd) < requiredCoverage) continue;

    const searched = matchDistributedWindow(
      relevantSpans,
      windowStart,
      windowEnd,
      requiredCoverage,
      searchBudget
    );
    if (searched === "budget_exceeded") {
      return inconclusiveDistributedOverlap(
        relevantSpans.map((span) => span.path),
        "position search budget exceeded"
      );
    }
    if (searched) return searched;
  }
  return undefined;
}

function buildDistributedMatchSpans(
  source: string,
  fields: readonly PublishableLlmField[]
): DistributedMatchBuild {
  const candidateFragments = new Set<string>();
  for (const field of fields) {
    for (const fragment of orderedCharacterShingles(field.normalizedContent, DISTRIBUTED_FRAGMENT_CHARACTERS)) {
      candidateFragments.add(fragment);
    }
  }
  if (candidateFragments.size === 0) return { spans: [] };

  // Retain every source occurrence. Sampling common fragments would be a
  // release bypass: a copied fingerprint could sit only at an omitted source
  // position. The map is linear in source length because each source position
  // contributes to exactly one sixteen-character key;
  // candidate/source pair expansion below has its own fail-closed budget.
  const sourcePositions = new Map<string, number[]>();
  for (let start = 0; start <= source.length - DISTRIBUTED_FRAGMENT_CHARACTERS; start += 1) {
    const fragment = source.slice(start, start + DISTRIBUTED_FRAGMENT_CHARACTERS);
    if (!candidateFragments.has(fragment)) continue;
    const positions = sourcePositions.get(fragment);
    if (positions) positions.push(start);
    else sourcePositions.set(fragment, [start]);
  }
  if (sourcePositions.size === 0) return { spans: [] };

  const spansByKey = new Map<string, DistributedMatchSpan>();
  const matchedPaths = new Set<string>();
  let anchorPairs = 0;
  for (const field of fields) {
    const candidate = field.normalizedContent;
    for (let candidateAnchor = 0; candidateAnchor <= candidate.length - DISTRIBUTED_FRAGMENT_CHARACTERS; candidateAnchor += 1) {
      const fragment = candidate.slice(candidateAnchor, candidateAnchor + DISTRIBUTED_FRAGMENT_CHARACTERS);
      const positions = sourcePositions.get(fragment);
      if (!positions) continue;
      matchedPaths.add(field.path);
      for (const sourceAnchor of positions) {
        anchorPairs += 1;
        if (anchorPairs > MAX_DISTRIBUTED_ANCHOR_PAIRS) {
          return { inconclusive: inconclusiveDistributedOverlap(matchedPaths, "anchor pair budget exceeded") };
        }
        const span = extendExactMatch(field, source, candidateAnchor, sourceAnchor);
        const key = [
          span.fieldIndex,
          span.candidateStart,
          span.candidateEnd,
          span.sourceStart,
          span.sourceEnd
        ].join(":");
        spansByKey.set(key, span);
        if (spansByKey.size > MAX_DISTRIBUTED_MATCH_SPANS) {
          return { inconclusive: inconclusiveDistributedOverlap(matchedPaths, "match span budget exceeded") };
        }
      }
    }
  }

  return { spans: [...spansByKey.values()] };
}

function extendExactMatch(
  field: PublishableLlmField,
  source: string,
  candidateAnchor: number,
  sourceAnchor: number
): DistributedMatchSpan {
  let candidateStart = candidateAnchor;
  let sourceStart = sourceAnchor;
  while (
    candidateStart > 0
    && sourceStart > 0
    && field.normalizedContent[candidateStart - 1] === source[sourceStart - 1]
  ) {
    candidateStart -= 1;
    sourceStart -= 1;
  }
  let candidateEnd = candidateAnchor + DISTRIBUTED_FRAGMENT_CHARACTERS;
  let sourceEnd = sourceAnchor + DISTRIBUTED_FRAGMENT_CHARACTERS;
  while (
    candidateEnd < field.normalizedContent.length
    && sourceEnd < source.length
    && field.normalizedContent[candidateEnd] === source[sourceEnd]
  ) {
    candidateEnd += 1;
    sourceEnd += 1;
  }
  return {
    fieldIndex: field.index,
    path: field.path,
    candidateStart,
    candidateEnd,
    sourceStart,
    sourceEnd
  };
}

function candidateCoverageUpperBound(
  spans: readonly DistributedMatchSpan[],
  windowStart: number,
  windowEnd: number
): number {
  const intervalsByField = new Map<number, Array<{ start: number; end: number }>>();
  for (const span of spans) {
    const clippedSourceStart = Math.max(span.sourceStart, windowStart);
    const clippedSourceEnd = Math.min(span.sourceEnd, windowEnd);
    if (clippedSourceEnd <= clippedSourceStart) continue;
    const leftClip = clippedSourceStart - span.sourceStart;
    const rightClip = span.sourceEnd - clippedSourceEnd;
    const candidateStart = span.candidateStart + leftClip;
    const candidateEnd = span.candidateEnd - rightClip;
    const intervals = intervalsByField.get(span.fieldIndex) ?? [];
    intervals.push({ start: candidateStart, end: candidateEnd });
    intervalsByField.set(span.fieldIndex, intervals);
  }
  let total = 0;
  for (const intervals of intervalsByField.values()) total += intervalUnionLength(intervals);
  return total;
}

/**
 * Computes exact source-position coverage as a bipartite matching. A left node
 * is one concrete candidate character position (field + offset); a right node
 * is one position in the protected 80-character source window. Edges exist
 * only when that aligned character belongs to an exact match of at least sixteen
 * characters. Maximum matching therefore lets overlapping maximal spans be
 * trimmed while still consuming every candidate and source position at most
 * once. Treating maximal spans as indivisible would miss legitimate split
 * reconstructions whenever two valid alignments overlap in the candidate.
 */
function matchDistributedWindow(
  spans: readonly DistributedMatchSpan[],
  windowStart: number,
  windowEnd: number,
  requiredCoverage: number,
  budget: { states: number }
): DistributedMatchWitness | "budget_exceeded" | undefined {
  const windowLength = windowEnd - windowStart;
  const adjacency = Array.from({ length: windowLength }, () => new Set<number>());
  const candidateNodeIds = new Map<string, number>();
  const candidateNodes: Array<{ fieldIndex: number; path: string; position: number }> = [];

  for (const span of spans) {
    const sourceStart = Math.max(span.sourceStart, windowStart);
    const sourceEnd = Math.min(span.sourceEnd, windowEnd);
    if (sourceEnd <= sourceStart) continue;
    const leftClip = sourceStart - span.sourceStart;
    const candidateStart = span.candidateStart + leftClip;
    for (let sourcePosition = sourceStart; sourcePosition < sourceEnd; sourcePosition += 1) {
      budget.states += 1;
      if (budget.states > MAX_DISTRIBUTED_DP_STATES) return "budget_exceeded";
      const candidatePosition = candidateStart + (sourcePosition - sourceStart);
      const candidateKey = `${span.fieldIndex}:${candidatePosition}`;
      let candidateNode = candidateNodeIds.get(candidateKey);
      if (candidateNode === undefined) {
        candidateNode = candidateNodeIds.size;
        candidateNodeIds.set(candidateKey, candidateNode);
        candidateNodes.push({
          fieldIndex: span.fieldIndex,
          path: span.path,
          position: candidatePosition
        });
      }
      adjacency[sourcePosition - windowStart]!.add(candidateNode);
    }
  }

  if (new Set(candidateNodes.map((node) => node.path)).size < 2
    || candidateNodeIds.size < requiredCoverage) return undefined;
  const edges = adjacency.map((nodes) => [...nodes]);
  const candidateToSource = new Int16Array(candidateNodeIds.size);
  candidateToSource.fill(-1);
  const visitStamp = new Uint16Array(candidateNodeIds.size);
  let stamp = 0;
  let budgetExceeded = false;

  const augment = (sourceOffset: number): boolean => {
    for (const candidateNode of edges[sourceOffset]!) {
      budget.states += 1;
      if (budget.states > MAX_DISTRIBUTED_DP_STATES) {
        budgetExceeded = true;
        return false;
      }
      if (visitStamp[candidateNode] === stamp) continue;
      visitStamp[candidateNode] = stamp;
      const priorSource = candidateToSource[candidateNode]!;
      if (priorSource < 0 || augment(priorSource)) {
        candidateToSource[candidateNode] = sourceOffset;
        return true;
      }
      if (budgetExceeded) return false;
    }
    return false;
  };

  let matched = 0;
  const sourceOrder = Array.from({ length: windowLength }, (_, offset) => offset)
    .sort((left, right) => edges[left]!.length - edges[right]!.length || left - right);
  for (const sourceOffset of sourceOrder) {
    stamp += 1;
    if (augment(sourceOffset)) matched += 1;
    if (budgetExceeded) return "budget_exceeded";
  }
  if (matched < requiredCoverage) return undefined;

  // The maximum-cardinality matching may choose one field when another field
  // has an interchangeable edge. Swap one occupied source position to that
  // unused field so the witness records the genuinely distributed matching.
  const sourceToCandidate = new Int32Array(windowLength);
  sourceToCandidate.fill(-1);
  for (let candidateNode = 0; candidateNode < candidateToSource.length; candidateNode += 1) {
    const sourceOffset = candidateToSource[candidateNode]!;
    if (sourceOffset >= 0) sourceToCandidate[sourceOffset] = candidateNode;
  }
  let usedPaths = new Set(
    [...candidateToSource]
      .map((sourceOffset, candidateNode) => sourceOffset >= 0 ? candidateNodes[candidateNode]!.path : undefined)
      .filter((path): path is string => path !== undefined)
  );
  if (usedPaths.size === 1) {
    const onlyPath = [...usedPaths][0]!;
    let swapped = false;
    for (let sourceOffset = 0; sourceOffset < edges.length && !swapped; sourceOffset += 1) {
      const currentNode = sourceToCandidate[sourceOffset]!;
      if (currentNode < 0) continue;
      const alternativeNode = edges[sourceOffset]!.find((node) => candidateNodes[node]!.path !== onlyPath);
      if (alternativeNode === undefined) continue;
      // No node on another path is currently occupied when `usedPaths` has one
      // member, so this preserves both source and candidate uniqueness.
      candidateToSource[currentNode] = -1;
      candidateToSource[alternativeNode] = sourceOffset;
      sourceToCandidate[sourceOffset] = alternativeNode;
      swapped = true;
    }
    usedPaths = new Set(
      [...candidateToSource]
        .map((sourceOffset, candidateNode) => sourceOffset >= 0 ? candidateNodes[candidateNode]!.path : undefined)
        .filter((path): path is string => path !== undefined)
    );
  }
  if (usedPaths.size < 2) return undefined;

  const sourcePositions: number[] = [];
  const candidatePositionsByPath = new Map<string, number[]>();
  for (let candidateNode = 0; candidateNode < candidateToSource.length; candidateNode += 1) {
    const sourceOffset = candidateToSource[candidateNode]!;
    if (sourceOffset < 0) continue;
    const node = candidateNodes[candidateNode]!;
    sourcePositions.push(windowStart + sourceOffset);
    const positions = candidatePositionsByPath.get(node.path) ?? [];
    positions.push(node.position);
    candidatePositionsByPath.set(node.path, positions);
  }
  const candidateRanges = [...candidatePositionsByPath]
    .map(([path, positions]) => ({ path, ranges: positionsToRanges(positions) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    contributorPaths: candidateRanges.map(({ path }) => path),
    matchedCharacters: sourcePositions.length,
    sourceWindow: { start: windowStart, end: windowEnd },
    sourceRanges: positionsToRanges(sourcePositions),
    candidateRanges
  };
}

function intervalUnionLength(intervals: readonly { start: number; end: number }[]): number {
  const sorted = [...intervals].sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let start = -1;
  let end = -1;
  for (const interval of sorted) {
    if (interval.end <= interval.start) continue;
    if (start < 0 || interval.start > end) {
      if (start >= 0) total += end - start;
      start = interval.start;
      end = interval.end;
    } else {
      end = Math.max(end, interval.end);
    }
  }
  return start < 0 ? 0 : total + end - start;
}

function positionsToRanges(positions: readonly number[]): NormalizedRange[] {
  const sorted = [...new Set(positions)].sort((left, right) => left - right);
  const ranges: NormalizedRange[] = [];
  for (const position of sorted) {
    const previous = ranges.at(-1);
    if (previous && previous.end === position) previous.end += 1;
    else ranges.push({ start: position, end: position + 1 });
  }
  return ranges;
}

function formatDistributedWitness(overlap: DistributedMatchWitness, sourceId: string): string {
  const candidateRanges = overlap.candidateRanges
    .map(({ path, ranges }) => `${singleLine(path)}=${formatNormalizedRanges(ranges)}`)
    .join(", ");
  return [
    `paths: ${overlap.contributorPaths.map(singleLine).join(", ")};`,
    `source_id: ${singleLine(sourceId)};`,
    `witness: distributed_exact_${DISTRIBUTED_FRAGMENT_CHARACTERS}_character_fragments;`,
    `source_window: ${formatNormalizedRange(overlap.sourceWindow)};`,
    `source_ranges: ${formatNormalizedRanges(overlap.sourceRanges)};`,
    `candidate_ranges: ${candidateRanges};`,
    `matched_normalized_characters: ${overlap.matchedCharacters}/${MINIMUM_PROTECTED_SPAN_CHARACTERS}`
  ].join(" ");
}

function formatNormalizedRanges(ranges: readonly NormalizedRange[]): string {
  return `[${ranges.map(formatNormalizedRange).join(",")}]`;
}

function formatNormalizedRange(range: NormalizedRange): string {
  return `[${range.start},${range.end})`;
}

function inconclusiveDistributedOverlap(
  paths: Iterable<string>,
  reason: DistributedInconclusive["reason"]
): DistributedInconclusive {
  const sorted = [...new Set(paths)].sort();
  const visible = sorted.slice(0, 8);
  if (sorted.length > visible.length) visible.push(`... (+${sorted.length - visible.length} publishable fields)`);
  if (visible.length === 0) visible.push("agent.json + cognitive assets");
  return { contributorPaths: visible, inconclusive: true, reason };
}

function findExactProtectedSpan(
  candidate: string,
  source: string,
  sourceHashes: ReadonlySet<number>
): { candidateRange: NormalizedRange; sourceRange: NormalizedRange } | undefined {
  const span = MINIMUM_PROTECTED_SPAN_CHARACTERS;
  let found: { candidateRange: NormalizedRange; sourceRange: NormalizedRange } | undefined;
  visitRollingHashes(candidate, span, (hash, start) => {
    if (found || !sourceHashes.has(hash)) return;
    const sourceStart = source.indexOf(candidate.slice(start, start + span));
    if (sourceStart < 0) return;
    found = {
      candidateRange: { start, end: start + span },
      sourceRange: { start: sourceStart, end: sourceStart + span }
    };
  });
  return found;
}

function sourcePositionsForCandidateShingles(
  source: string,
  candidateShingles: Set<string>,
  size: number
): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  for (let index = 0; index <= source.length - size; index += 1) {
    const shingle = source.slice(index, index + size);
    if (!candidateShingles.has(shingle)) continue;
    const current = positions.get(shingle);
    if (current) current.push(index);
    else positions.set(shingle, [index]);
  }
  return positions;
}

function rarestWindowAnchor(
  candidateShingles: readonly string[],
  sourcePositions: ReadonlyMap<string, readonly number[]>,
  start: number,
  end: number
): { candidateIndex: number; positions: readonly number[] } | undefined {
  let result: { candidateIndex: number; positions: readonly number[] } | undefined;
  for (let index = start; index < end; index += 1) {
    const positions = sourcePositions.get(candidateShingles[index]!);
    if (!positions || positions.length === 0) continue;
    if (!result || positions.length < result.positions.length) result = { candidateIndex: index, positions };
  }
  return result;
}

function orderedLocalCoverage(
  candidateShingles: readonly string[],
  sourcePositions: ReadonlyMap<string, readonly number[]>,
  start: number,
  end: number,
  sourceWindowStart: number
): { coverage: number; sourceRange?: NormalizedRange } {
  let matches = 0;
  let lastSourcePosition = -1;
  let firstSourcePosition = -1;
  for (let candidateIndex = start; candidateIndex < end; candidateIndex += 1) {
    const positions = sourcePositions.get(candidateShingles[candidateIndex]!);
    if (!positions) continue;
    const expected = sourceWindowStart + (candidateIndex - start);
    const minimum = Math.max(lastSourcePosition + 1, expected - MAXIMUM_ALIGNMENT_DRIFT_CHARACTERS);
    const positionIndex = lowerBound(positions, minimum);
    const position = positions[positionIndex];
    if (position === undefined || position > expected + MAXIMUM_ALIGNMENT_DRIFT_CHARACTERS) continue;
    matches += 1;
    if (firstSourcePosition < 0) firstSourcePosition = position;
    lastSourcePosition = position;
  }
  return {
    coverage: matches / (end - start),
    ...(firstSourcePosition < 0 ? {} : {
      sourceRange: {
        start: firstSourcePosition,
        end: lastSourcePosition + OVERLAP_SHINGLE_CHARACTERS
      }
    })
  };
}

function nearVerbatimWindowSizes(candidateLength: number, sourceLength: number): number[] {
  const maximum = Math.min(MAXIMUM_NEAR_VERBATIM_WINDOW_CHARACTERS, candidateLength, sourceLength);
  const sizes = [MINIMUM_PROTECTED_SPAN_CHARACTERS, 160, MAXIMUM_NEAR_VERBATIM_WINDOW_CHARACTERS]
    .filter((size) => size <= maximum);
  if (!sizes.includes(maximum)) sizes.push(maximum);
  return [...new Set(sizes)].sort((left, right) => left - right);
}

function windowStarts(candidateLength: number, windowLength: number): number[] {
  const last = candidateLength - windowLength;
  const starts: number[] = [];
  for (let start = 0; start <= last; start += OVERLAP_SHINGLE_CHARACTERS) starts.push(start);
  if (starts.at(-1) !== last) starts.push(last);
  return starts;
}

function sampledPositions(positions: readonly number[], limit: number): number[] {
  if (positions.length <= limit) return [...positions];
  const result: number[] = [];
  for (let index = 0; index < limit; index += 1) {
    result.push(positions[Math.floor(index * (positions.length - 1) / (limit - 1))]!);
  }
  return result;
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function rollingHashes(value: string, windowLength: number): Set<number> {
  const result = new Set<number>();
  visitRollingHashes(value, windowLength, (hash) => result.add(hash));
  return result;
}

function visitRollingHashes(
  value: string,
  windowLength: number,
  visit: (hash: number, start: number) => void
): void {
  if (value.length < windowLength) return;
  const base = 16777619;
  let highestPower = 1;
  for (let index = 1; index < windowLength; index += 1) highestPower = Math.imul(highestPower, base) >>> 0;
  let hash = 0;
  for (let index = 0; index < windowLength; index += 1) {
    hash = (Math.imul(hash, base) + value.charCodeAt(index) + 1) >>> 0;
  }
  visit(hash, 0);
  for (let start = 1; start <= value.length - windowLength; start += 1) {
    hash = (hash - Math.imul(value.charCodeAt(start - 1) + 1, highestPower)) >>> 0;
    hash = (Math.imul(hash, base) + value.charCodeAt(start + windowLength - 1) + 1) >>> 0;
    visit(hash, start);
  }
}

function cognitiveAssets(compilation: CorpusCompilation): Array<{ path: string; content: string }> {
  return [
    { path: "instructions/system.md", content: compilation.systemInstructions },
    ...compilation.skills.map(({ path, content }) => ({ path, content })),
    ...compilation.references.map(({ path, content }) => ({ path, content })),
    ...compilation.knowledge.map(({ path, content }) => ({ path, content }))
  ];
}

/** Every LLM-authored string that survives into agent.json or a Runtime-visible
 * Corpus asset. Operator-owned product/tool metadata is intentionally absent. */
function publishableLlmFields(compilation: CorpusCompilation): Array<{ path: string; content: string }> {
  return [
    { path: "instructions/system.md", content: compilation.systemInstructions },
    ...compilation.skills.flatMap((skill) => [
      { path: skill.path, content: skill.content },
      { path: `agent.json#skills/${skill.id}/name`, content: skill.name },
      { path: `agent.json#skills/${skill.id}/when_to_use`, content: skill.whenToUse }
    ]),
    ...compilation.references.map(({ path, content }) => ({ path, content })),
    ...compilation.knowledge.flatMap((document) => [
      { path: document.path, content: document.content },
      { path: `agent.json#knowledge/${document.id}/source_summary`, content: document.sourceSummary }
    ])
  ];
}

function orderedCharacterShingles(value: string, size: number): string[] {
  const result: string[] = [];
  for (let index = 0; index <= value.length - size; index += 1) result.push(value.slice(index, index + size));
  return result;
}

function markdownHeadings(value: string): string[] {
  return [...value.matchAll(/^##+\s+(.+?)\s*$/gm)].map((match) => match[1]!.trim());
}

function semanticSize(value: string): number {
  return value.replace(/\s+/g, "").length;
}

function normalizeComparableText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function percentage(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}
