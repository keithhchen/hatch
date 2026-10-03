const thinkingTextSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function latestThinkingText(content, limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new RangeError("Thinking preview limit must be an integer greater than one");
  const normalized = content.replace(/\s+/gu, " ").trim();
  const characters = [...thinkingTextSegmenter.segment(normalized)].map(({ segment }) => segment);
  if (characters.length <= limit) return normalized;
  return `…${characters.slice(-(limit - 1)).join("")}`;
}
