// The first-build onboarding dialog: when it shows and how it is remembered.
// It shows by itself on the New Agent page while the account's real Agent list is empty; the help button opens it any time.
// That it was dismissed is a per-viewer convenience: it lives in localStorage, keyed by account, and may be missing.

const keyFor = (accountId) => `hatch.firstBuildIntro.${accountId}`;

export function introDismissed(accountId, storage = globalThis.localStorage) {
  try { return storage?.getItem(keyFor(accountId)) === "1"; } catch { return false; }
}

export function dismissIntro(accountId, storage = globalThis.localStorage) {
  try { storage?.setItem(keyFor(accountId), "1"); } catch { /* the dialog may show again; nothing else depends on this */ }
}

/** The account has no Agent yet. A list that has not loaded is unknown, not empty. */
export function shouldShowFirstBuildIntro({ accountId, storage, products }) {
  return Boolean(accountId) && !introDismissed(accountId, storage) && Array.isArray(products) && products.length === 0;
}
