// The first-build onboarding dialog: when it shows by itself.
// It opens on every visit to the New Agent page while the account's real Agent list is empty; the help button opens it any time.

/** The account has no Agent yet. A list that has not loaded is unknown, not empty. */
export function shouldShowFirstBuildIntro({ accountId, products }) {
  return Boolean(accountId) && Array.isArray(products) && products.length === 0;
}
