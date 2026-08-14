const NO_REVERSAL_STATUSES = new Set([
  "none",
  "not_applicable",
  "not_requested",
  "not_required"
]);

export function meaningfulReversalStatus(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (normalized && !NO_REVERSAL_STATUSES.has(normalized)) return normalized;
  }
  return null;
}
