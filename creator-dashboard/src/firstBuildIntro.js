// The first-build onboarding dialog: when it shows and how it is remembered.
// Whether it shows is derived from the account's real Agent list and the Agent's real material.
// That it was dismissed is a per-viewer convenience: it lives in localStorage, keyed by account, and may be missing.

const keyFor = (accountId) => `hatch.firstBuildIntro.${accountId}`;
const idOf = (product) => String(product?.product_id ?? product?.id ?? "");

export function introDismissed(accountId, storage = globalThis.localStorage) {
  try { return storage?.getItem(keyFor(accountId)) === "1"; } catch { return false; }
}

export function dismissIntro(accountId, storage = globalThis.localStorage) {
  try { storage?.setItem(keyFor(accountId), "1"); } catch { /* the dialog may show again; nothing else depends on this */ }
}

/** The Expert's only Agent, with no upload and no interview yet. Anything not yet loaded is not a first Agent. */
export function isFirstAgentWithoutMaterial({ products, productId, manualFiles, agents }) {
  if (!Array.isArray(products) || products.length !== 1 || idOf(products[0]) !== String(productId)) return false;
  if (!Array.isArray(manualFiles) || !Array.isArray(agents)) return false;
  const interviewed = agents.some((agent) => agent.role === "voice" && agent.outputUpdatedAt);
  return manualFiles.length === 0 && !interviewed;
}

export function shouldShowFirstBuildIntro({ accountId, storage, ...facts }) {
  return Boolean(accountId) && !introDismissed(accountId, storage) && isFirstAgentWithoutMaterial(facts);
}
