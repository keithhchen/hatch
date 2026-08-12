const ROOT = "/portal/creator";
const PRODUCT_TABS = new Set(["overview", "test", "examples", "versions", "data-controls"]);

export function parseCreatorRoute(pathname) {
  const clean = `/${String(pathname ?? "").split(/[?#]/)[0].split("/").filter(Boolean).join("/")}`;
  const normalized = clean === "/portal" ? ROOT : clean;
  if (normalized !== ROOT && !normalized.startsWith(`${ROOT}/`)) return { kind: "not-found", section: "" };
  const segments = normalized.slice(ROOT.length).split("/").filter(Boolean).map(safeDecode);
  if (!segments.length) return { kind: "home", section: "home" };
  if (segments[0] === "factory") {
    if (segments[1] === "runs" && segments[2]) return { kind: "factory", section: "products", runId: segments[2] };
    return segments.length === 1 ? { kind: "factory", section: "products" } : { kind: "not-found", section: "products" };
  }
  if (segments[0] === "products") {
    if (segments.length === 1) return { kind: "products", section: "products" };
    if (segments[1] === "new") return { kind: "factory", section: "products", productId: "" };
    const productId = segments[1];
    if (segments.length === 2) return { kind: "product", section: "products", productId, tab: "overview" };
    if (PRODUCT_TABS.has(segments[2])) return { kind: "product", section: "products", productId, tab: segments[2] };
    if (segments[2] === "factory") {
      if (segments[3] === "runs" && segments[4]) return { kind: "factory", section: "products", productId, runId: segments[4] };
      if (segments[3] && segments[3] !== "runs") return { kind: "factory", section: "products", productId, runId: segments[3] };
      return { kind: "factory", section: "products", productId };
    }
    if (segments[2] === "offer") return { kind: "offer", section: "products", productId };
    if (segments[2] === "preview") return { kind: "preview", section: "products", productId };
    if (segments[2] === "candidates" && segments[3]) return { kind: "candidate", section: "products", productId, candidateId: segments[3] };
    if (segments[2] === "releases" && segments[3]) return { kind: "release", section: "products", productId, releaseId: segments[3] };
  }
  if (segments[0] === "orders") return segments[1] ? { kind: "order", section: "orders", orderId: segments[1] } : { kind: "orders", section: "orders" };
  if (segments[0] === "payouts") return segments[1] ? { kind: "payout", section: "payouts", payoutId: segments[1] } : { kind: "payouts", section: "payouts" };
  if (segments[0] === "settings" && segments[1] === "payouts" && segments.length === 2) return { kind: "payout-settings", section: "payouts" };
  return { kind: "not-found", section: "" };
}

export function creatorRouteTitle(route) {
  if (route.kind === "home") return "Creator home";
  if (route.kind === "products") return "Products";
  if (route.kind === "factory") return route.runId ? "Factory run" : "Creator Factory";
  if (route.kind === "candidate") return "Candidate review";
  if (route.kind === "offer") return "Offer and pricing";
  if (route.kind === "preview") return "Storefront preview";
  if (route.kind === "release") return "Release";
  if (route.kind === "orders") return "Creator orders";
  if (route.kind === "order") return "Creator order";
  if (route.kind === "payout-settings") return "Payout settings";
  if (route.kind === "payout") return "Payout detail";
  if (route.kind === "payouts") return "Payouts";
  if (route.kind === "product") return "Product";
  return "Creator dashboard";
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}
