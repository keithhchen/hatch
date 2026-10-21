// Publish readiness, as returned by the dashboard on every Creator Product
// (`product.readiness`). The server reports six checks plus English blocker
// strings; the UI shows each check in the reader's language.
export const READINESS_CHECKS = Object.freeze([
  { key: "candidate_approved", blocker: "candidate approval is stale", fix: "build" },
  { key: "no_critical_failures", blocker: "critical candidate gates are incomplete", fix: "evaluate" },
  { key: "public_copy_complete", blocker: "public promise, description, or boundaries are incomplete", fix: "storefront" },
  { key: "ownership_valid", blocker: "Expert ownership is missing", fix: null },
  { key: "materialization_ready", blocker: "Registry materialization is not ready", fix: "build" },
  { key: "product_identity_valid", blocker: "canonical Product UUID is invalid", fix: null }
]);

/**
 * Turns `product.readiness` into display rows. Returns null when the server did
 * not send readiness, so the page can say so instead of guessing.
 * Blockers the UI does not know are kept as raw strings in `unknownBlockers`.
 */
export function readinessChecklist(readiness) {
  if (!readiness || typeof readiness !== "object" || Array.isArray(readiness)) return null;
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers.map(String) : [];
  const known = new Set(READINESS_CHECKS.map((check) => check.blocker));
  const items = READINESS_CHECKS.map((check) => ({
    key: check.key,
    fix: check.fix,
    ready: readiness[check.key] === true && !blockers.includes(check.blocker)
  }));
  const unknownBlockers = blockers.filter((blocker) => !known.has(blocker));
  return {
    items,
    unknownBlockers,
    blocking: items.filter((item) => !item.ready).length + unknownBlockers.length,
    ready: readiness.ready === true && items.every((item) => item.ready) && !unknownBlockers.length
  };
}
