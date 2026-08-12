export function storefrontList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item.trim();
    if (!item || typeof item !== "object") return "";
    return String(item.label ?? item.title ?? item.description ?? item.summary ?? "").trim();
  }).filter(Boolean);
}

export function storefrontModel(product = {}, options = {}) {
  return {
    name: String(product.name ?? product.product_name ?? "Untitled product"),
    promise: String(product.promise ?? product.product_promise ?? product.description ?? product.product_description ?? ""),
    inputs: storefrontList(product.inputs ?? product.what_you_provide ?? product.requirements ?? product.presentation?.inputs),
    outputs: storefrontList(product.outputs ?? product.what_you_receive ?? product.deliverables ?? product.presentation?.outputs),
    boundaries: storefrontList(product.boundaries ?? product.product_boundaries ?? product.limitations ?? product.presentation?.boundaries),
    privacy: String(product.privacy_copy ?? product.presentation?.privacy_copy ?? ""),
    desktopRequirement: String(
      options.desktopRequirement
      ?? product.desktop_requirement
      ?? product.presentation?.desktop_requirement
      ?? ""
    ),
    refundPolicy: String(
      options.refundPolicy
      ?? product.refund_policy?.summary
      ?? product.refund_policy_summary
      ?? product.presentation?.refund_policy
      ?? ""
    )
  };
}

export function payoutActionLabel(status) {
  if (status === "not_connected") return "Connect payouts";
  if (["onboarding_incomplete", "under_review", "restricted"].includes(status)) return "Continue setup";
  return "Manage payouts";
}

export function payoutCanRetry(status) {
  return status === "failed";
}

export function creatorOrderQuery(filters = {}) {
  const params = new URLSearchParams();
  for (const key of ["order", "payment", "delivery", "product", "from", "to", "refund", "limit"]) {
    const value = filters[key];
    if (value !== undefined && value !== null && String(value).trim()) params.set(key, String(value).trim());
  }
  return params.toString();
}
