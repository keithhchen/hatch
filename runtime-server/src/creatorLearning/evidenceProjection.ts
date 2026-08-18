import { createHash } from "node:crypto";
import { auditRawSourceOverlap } from "./corpusReleaseGuards.js";
import type { FactorySource } from "./types.js";

/**
 * The Evidence artifact is the Factory source of truth and intentionally keeps
 * provenance, including exact excerpts. The Corpus compiler needs the
 * supported meaning and routing metadata, but it must not receive those raw
 * excerpts as reusable prose. This module creates that compiler-only view.
 *
 * The projection is deliberately conservative: it removes explicitly marked
 * excerpt/quote lines and any long normalized span that is found in an
 * authorized source. Everything else, including section headings, semantic
 * interpretation, uncertainty, routing, authority, and source/line references,
 * remains unchanged. The original Evidence artifact is never rewritten.
 */

const QUOTED_MATCH_MINIMUM = 20;
const MAX_SOURCE_REDACTION_PASSES = 256;

type SourceLike = Pick<FactorySource, "id" | "authority" | "title" | "content">;

type Span = { start: number; end: number };

type Redaction = Span & { sourceIds: string[]; lineRefs: string[] };

type NormalizedText = {
  chars: string[];
  originalSpans: Span[];
};

/**
 * Build a compiler-only Evidence view. The source metadata is intentionally
 * digest-based; source content and source titles are never copied into the
 * projection.
 */
export function projectEvidenceForCorpus(
  evidence: string,
  sources: readonly SourceLike[]
): string {
  const projected = sanitizeEvidence(evidence, sources);
  const metadata = sources.length === 0
    ? ["- None supplied; retain any source/line references already present in Evidence."]
    : sources.map((source) => (
      `- source_id: ${singleLine(source.id)}; authority: ${source.authority}; `
      + `sha256: sha256:${createHash("sha256").update(source.content, "utf8").digest("hex")}`
    ));

  return [
    "# Sanitized Evidence projection for Corpus compiler",
    "",
    "This is a compiler-only projection. The complete Evidence artifact remains Factory-only and is the source of truth for provenance.",
    "Exact excerpts and source-matching prose have been removed below. Preserve the retained sections, semantic meaning, decisions, boundaries, uncertainty, authority, confidence, layer routing, and source/line references; do not reconstruct removed wording.",
    "",
    "## Source provenance metadata",
    ...metadata,
    "",
    "## Distilled Evidence sections",
    projected.trim(),
    ""
  ].join("\n");
}

function sanitizeEvidence(
  evidence: string,
  sources: readonly SourceLike[]
): string {
  if (!evidence || sources.length === 0) {
    return applyRedactions(evidence, explicitExcerptRedactions(evidence));
  }
  const normalizedSources = sources.map((source) => normalizeWithMap(source.content));
  let projected = applyRedactions(
    evidence,
    mergeRedactions([
      ...explicitExcerptRedactions(evidence),
      ...quotedSourceRedactions(evidence, normalizedSources, sources)
    ])
  );

  // One guard call returns the first witness per source/field. A large Evidence
  // artifact may contain several independent copied spans, so repeat the same
  // deterministic redaction until the compiler view has no further witnesses.
  for (let attempt = 0; attempt < MAX_SOURCE_REDACTION_PASSES; attempt += 1) {
    const normalizedEvidence = normalizeWithMap(projected);
    const redactions = guardSourceRedactions(projected, normalizedEvidence, sources);
    if (redactions.length === 0) break;
    projected = applyRedactions(projected, mergeRedactions(redactions));
    if (attempt === MAX_SOURCE_REDACTION_PASSES - 1) {
      // Never hand the compiler a view that still has an unresolved source
      // witness. This is an exceptional fail-closed path; the durable Evidence
      // artifact remains intact and can be retried after the detector/provider
      // behavior is investigated.
      projected = "[Evidence projection withheld: the deterministic source boundary did not converge.]";
    }
  }
  return projected;
}

/** Remove an explicitly labelled excerpt even when it is shorter than the
 * release guard's protected-span floor. References on that line are copied as
 * identifiers only; the prose after the label is never retained. */
function explicitExcerptRedactions(evidence: string): Redaction[] {
  const redactions: Redaction[] = [];
  let offset = 0;
  for (const line of evidence.split("\n")) {
    const match = line.match(
      /^(\s*(?:[-*+]\s+|\d+[.)]\s+)?)((?:exact\s+)?excerpt|verbatim|direct\s+quote|quoted\s+source|source\s+(?:text|excerpt))\s*[:：\-]\s*(.*)$/i
    );
    if (match) {
      const colonOffset = line.slice(match[1]!.length + match[2]!.length).search(/[:：\-]/);
      const contentStart = offset + match[1]!.length + match[2]!.length + Math.max(0, colonOffset) + 1;
      const references = referenceTokens(match[3]!);
      redactions.push({
        start: contentStart,
        end: offset + line.length,
        sourceIds: references.sourceIds,
        lineRefs: references.lineRefs
      });
      // Keep the label itself and the source/line metadata outside the removed
      // body. The replacement is applied later, after overlapping matches are
      // merged with source-aware spans.
    }
    offset += line.length + 1;
  }
  return redactions;
}

function quotedSourceRedactions(
  evidence: string,
  normalizedSources: readonly NormalizedText[],
  sources: readonly SourceLike[]
): Redaction[] {
  const redactions: Redaction[] = [];
  const quoted = /"([^"\n]{20,})"|“([^”\n]{20,})”|`([^`\n]{20,})`/g;
  for (const match of evidence.matchAll(quoted)) {
    const content = match[1] ?? match[2] ?? match[3] ?? "";
    const normalized = normalizeWithMap(content).chars;
    if (normalized.length < QUOTED_MATCH_MINIMUM) continue;
    for (let sourceIndex = 0; sourceIndex < normalizedSources.length; sourceIndex += 1) {
      if (findSequence(normalizedSources[sourceIndex]!.chars, normalized) === -1) continue;
      const start = (match.index ?? 0) + 1;
      redactions.push({
        start,
        end: start + content.length,
        sourceIds: [sources[sourceIndex]!.id],
        lineRefs: []
      });
      break;
    }
  }
  return redactions;
}

/**
 * Reuse the release guard's exact/near-verbatim detector as the source of
 * truth. The fake compilation has one non-runtime field, so the guard returns
 * only safe position metadata; no source or Evidence prose is persisted.
 */
function guardSourceRedactions(
  evidence: string,
  normalizedEvidence: NormalizedText,
  sources: readonly SourceLike[]
): Redaction[] {
  const violations = auditRawSourceOverlap({
    format: "layered-assets",
    systemInstructions: evidence,
    skills: [],
    references: [],
    knowledge: [],
    changeRationale: "projection-only",
    requirementsTraceability: "projection-only",
    preservationAudit: "projection-only"
  }, sources);
  const redactions: Redaction[] = [];
  let inconclusive = false;
  for (const violation of violations) {
    const ranges = [
      ...violation.detail.matchAll(/candidate_range:\s*\[(\d+),(\d+)\)/g),
      ...violation.detail.matchAll(/instructions\/system\.md=\[\[(\d+),(\d+)\)/g)
    ];
    for (const match of ranges) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      const mappedStart = normalizedEvidence.originalSpans[start]?.start;
      const mappedEnd = normalizedEvidence.originalSpans[end - 1]?.end;
      if (mappedStart === undefined || mappedEnd === undefined || end <= start) continue;
      redactions.push({
        start: mappedStart,
        end: mappedEnd,
        sourceIds: violation.sourceId ? [violation.sourceId] : [],
        lineRefs: []
      });
    }
    if (violation.code === "raw_source_overlap_inconclusive" && ranges.length === 0) {
      inconclusive = true;
    }
  }
  if (inconclusive) {
    return [{
      start: 0,
      end: evidence.length,
      sourceIds: [],
      lineRefs: []
    }];
  }
  return redactions;
}

function normalizeWithMap(value: string): NormalizedText {
  const chars: string[] = [];
  const originalSpans: Span[] = [];
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    const raw = value.slice(index, index + (codePoint > 0xffff ? 2 : 1));
    const normalized = raw.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    // Keep one entry per UTF-16 code unit, matching the offsets produced by
    // corpusReleaseGuards.normalizeComparableText(). This matters for an
    // astral Unicode character: the guard reports two code units, not one
    // Unicode scalar value.
    for (let normalizedIndex = 0; normalizedIndex < normalized.length; normalizedIndex += 1) {
      chars.push(normalized[normalizedIndex]!);
      originalSpans.push({ start: index, end: index + raw.length });
    }
    index += raw.length;
  }
  return { chars, originalSpans };
}

function findSequence(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0) return 0;
  if (needle.length > haystack.length) return -1;
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) continue outer;
    }
    return start;
  }
  return -1;
}

function applyRedactions(value: string, redactions: readonly Redaction[]): string {
  if (redactions.length === 0) return value;
  let output = "";
  let cursor = 0;
  for (const redaction of redactions) {
    if (redaction.start < cursor) continue;
    output += value.slice(cursor, redaction.start);
    const ids = [...new Set(redaction.sourceIds.filter(Boolean))];
    const lineRefs = [...new Set(redaction.lineRefs.filter(Boolean))];
    const metadata = [
      ...(ids.length > 0 ? [`source_id: ${ids.join(", ")}`] : []),
      ...(lineRefs.length > 0 ? [`line_ref: ${lineRefs.join(", ")}`] : [])
    ];
    output += metadata.length > 0
      ? `[REDACTED_SOURCE_TEXT; ${metadata.join("; ")}]`
      : "[REDACTED_SOURCE_TEXT]";
    cursor = redaction.end;
  }
  return output + value.slice(cursor);
}

function mergeRedactions(redactions: readonly Redaction[]): Redaction[] {
  const sorted = redactions
    .filter((redaction) => redaction.end > redaction.start)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Redaction[] = [];
  for (const redaction of sorted) {
    const current = merged.at(-1);
    if (!current || redaction.start > current.end) {
      merged.push({
        ...redaction,
        sourceIds: [...redaction.sourceIds],
        lineRefs: [...redaction.lineRefs]
      });
      continue;
    }
    current.end = Math.max(current.end, redaction.end);
    current.sourceIds = [...new Set([...current.sourceIds, ...redaction.sourceIds])];
    current.lineRefs = [...new Set([...current.lineRefs, ...redaction.lineRefs])];
  }
  return merged;
}

function referenceTokens(value: string): { sourceIds: string[]; lineRefs: string[] } {
  const sourceIds = [
    ...value.matchAll(/\[\s*([^:\]\s]+)\s*:\s*L\d+(?:[-–]L?\d+)?[^\]]*\]/gi),
    ...value.matchAll(/\bsource[-_][A-Za-z0-9-]{4,}\b/gi),
    ...value.matchAll(/\bS\d+\b/g)
  ].map((match) => match[1] ?? match[0]!);
  const lineRefs = [...value.matchAll(/\bL\d+(?:[-–]L?\d+)?\b/g)].map((match) => match[0]!);
  return {
    sourceIds: [...new Set(sourceIds)],
    lineRefs: [...new Set(lineRefs)]
  };
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}
