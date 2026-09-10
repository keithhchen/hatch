const ROOT = "/studio";
const PRODUCT_TABS = new Set(["files", "about-you", "corpus", "brief", "complete"]);
const RETIRED_PRODUCT_TABS = new Map([
  ["overview", "files"],
  ["test", "about-you"],
  ["examples", "corpus"],
  ["versions", "complete"],
  ["data-controls", "files"]
]);
export const FACTORY_SECTION_AGENTS = Object.freeze({
  sources: Object.freeze(["research", "voice"]),
  build: Object.freeze(["generation"]),
  evaluate: Object.freeze(["case-generation", "evaluator"])
});

export function factorySectionForAgent(role) {
  return Object.entries(FACTORY_SECTION_AGENTS).find(([, roles]) => roles.includes(role))?.[0] ?? null;
}

export function creatorFactoryPath(productId, factorySection, factoryAgent) {
  const root = `${ROOT}/factory/${encodeURIComponent(productId)}`;
  if (factorySection === undefined) return root;
  if (!Object.hasOwn(FACTORY_SECTION_AGENTS, factorySection)) throw new RangeError("Unknown Factory section");
  const sectionPath = `${root}/${factorySection}`;
  if (factoryAgent === undefined) return sectionPath;
  if (!FACTORY_SECTION_AGENTS[factorySection].includes(factoryAgent)) throw new RangeError("Agent does not belong to Factory section");
  return `${sectionPath}/${factoryAgent}`;
}

export function parseCreatorRoute(pathname) {
  const clean = `/${String(pathname ?? "").split(/[?#]/)[0].split("/").filter(Boolean).join("/")}`;
  const normalized = clean;
  if (normalized !== ROOT && !normalized.startsWith(`${ROOT}/`)) return { kind: "not-found", section: "" };
  const segments = normalized.slice(ROOT.length).split("/").filter(Boolean).map(safeDecode);
  if (!segments.length) return { kind: "home", section: "home" };
  if (segments[0] === "products" && segments.length === 2 && segments[1] === "new") return { kind: "product-create", section: "products" };
  if (segments[0] === "factory") {
    if (segments.length === 1) return { kind: "factory-index", section: "products" };
    const productId = segments[1];
    if (segments.length === 2) return { kind: "factory-agents", section: "products", productId };
    const factorySection = segments[2];
    if (!Object.hasOwn(FACTORY_SECTION_AGENTS, factorySection)) return { kind: "not-found", section: "products" };
    if (segments.length === 3) return { kind: "factory-agents", section: "products", productId, factorySection };
    const factoryAgent = segments[3];
    if (segments.length === 4 && FACTORY_SECTION_AGENTS[factorySection].includes(factoryAgent)) {
      return { kind: "factory-agents", section: "products", productId, factorySection, factoryAgent };
    }
    return { kind: "not-found", section: "products" };
  }
  if (segments[0] === "products") {
    if (segments.length === 1) return { kind: "products", section: "products" };
    const productId = segments[1];
    if (segments.length === 2) return { kind: "product", section: "products", productId, tab: "files" };
    if (PRODUCT_TABS.has(segments[2])) return { kind: "product", section: "products", productId, tab: segments[2] };
    if (RETIRED_PRODUCT_TABS.has(segments[2])) return { kind: "product", section: "products", productId, tab: RETIRED_PRODUCT_TABS.get(segments[2]) };
    if (segments[2] === "preview") return { kind: "preview", section: "products", productId };
    if (segments[2] === "candidates" && segments[3]) return { kind: "candidate", section: "products", productId, candidateId: segments[3] };
    if (segments[2] === "releases" && segments[3]) return { kind: "release", section: "products", productId, releaseId: segments[3] };
  }
  if (segments[0] === "orders") return segments[1] ? { kind: "order", section: "orders", orderId: segments[1] } : { kind: "orders", section: "orders" };
  return { kind: "not-found", section: "" };
}

export function creatorRouteTitle(route) {
  if (route.kind === "factory-agents" || route.kind === "factory-index") return "Factory";
  if (route.kind === "home") return "Creator home";
  if (route.kind === "products") return "Products";
  if (route.kind === "product-create") return "Create product";
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
