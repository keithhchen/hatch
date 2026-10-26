const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The newest `limit` graphemes of a thinking stream, for a one-line ticker. */
export function latestThinkingText(content, limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new RangeError("Thinking preview limit must be an integer greater than one");
  const normalized = content.replace(/\s+/gu, " ").trim();
  const characters = [...graphemes.segment(normalized)].map(({ segment }) => segment);
  if (characters.length <= limit) return normalized;
  return `…${characters.slice(-(limit - 1)).join("")}`;
}

/** Durable image assets render as pictures; everything else as file chips. */
export function partitionAttachments(message, accepts) {
  const attachments = message.attachments ?? [];
  return {
    files: attachments.filter(item => !accepts(item.media_type)),
    pictures: message.optimistic ? [] : attachments.filter(item => accepts(item.media_type) && item.asset_id)
  };
}

/**
 * The approval state of a tool row: a decision made in this client
 * ("pending" | "allowed" | "denied", keyed by tool_call_id) or, for durable
 * history, a denial recorded on the call. Anything else has no approval row.
 */
export function approvalDecision(entry, decisions = {}) {
  if (entry.kind !== "tool") return null;
  return decisions[entry.content.toolCallId] ?? (entry.content.error?.code === "approval_denied" ? "denied" : null);
}
