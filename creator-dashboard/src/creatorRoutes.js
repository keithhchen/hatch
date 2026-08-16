const ROOT = "/studio";
const PRODUCT_TABS = new Set(["files", "about-you", "review", "brief", "complete"]);

export function parseCreatorRoute(pathname) {
  const clean = `/${String(pathname ?? "").split(/[?#]/)[0].split("/").filter(Boolean).join("/")}`;
  const normalized = clean;
  if (normalized !== ROOT && !normalized.startsWith(`${ROOT}/`)) return { kind: "not-found", section: "" };
  const segments = normalized.slice(ROOT.length).split("/").filter(Boolean).map(safeDecode);
  if (!segments.length) return { kind: "home", section: "home" };
  if (segments[0] === "products" && segments.length === 2 && segments[1] === "new") return { kind: "product-create", section: "products" };
  if (segments[0] === "factory") {
    if (segments.length === 3 && segments[1] === "runs" && segments[2]) return { kind: "factory", section: "products", runId: segments[2] };
    if (segments.length === 2 && segments[1]) return { kind: "factory", section: "products", runId: segments[1] };
    return segments.length === 1 ? { kind: "factory", section: "products" } : { kind: "not-found", section: "products" };
  }
  if (segments[0] === "products") {
    if (segments.length === 1) return { kind: "products", section: "products" };
    const productId = segments[1];
    if (segments.length === 2) return { kind: "product", section: "products", productId, tab: "files" };
    if (PRODUCT_TABS.has(segments[2])) return { kind: "product", section: "products", productId, tab: segments[2] };
    if (segments[2] === "factory") {
      if (segments[3] === "runs" && segments[4]) return { kind: "factory", section: "products", productId, runId: segments[4] };
      if (segments[3] && segments[3] !== "runs") return { kind: "factory", section: "products", productId, runId: segments[3] };
      return { kind: "factory", section: "products", productId };
    }
    if (segments[2] === "preview") return { kind: "preview", section: "products", productId };
    if (segments[2] === "candidates" && segments[3]) return { kind: "candidate", section: "products", productId, candidateId: segments[3] };
    if (segments[2] === "releases" && segments[3]) return { kind: "release", section: "products", productId, releaseId: segments[3] };
  }
  if (segments[0] === "orders") return segments[1] ? { kind: "order", section: "orders", orderId: segments[1] } : { kind: "orders", section: "orders" };
  return { kind: "not-found", section: "" };
}

export function creatorRouteTitle(route) {
  if (route.kind === "home") return "Creator home";
  if (route.kind === "products") return "Products";
  if (route.kind === "product-create") return "Create product";
  if (route.kind === "factory") return route.runId ? "Version" : "Product workflow";
  if (route.kind === "candidate") return "Candidate review";
  if (route.kind === "preview") return "Storefront preview";
  if (route.kind === "release") return "Release";
  if (route.kind === "orders") return "Creator orders";
  if (route.kind === "order") return "Creator order";
  if (route.kind === "product") return "Product";
  return "Creator dashboard";
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}
