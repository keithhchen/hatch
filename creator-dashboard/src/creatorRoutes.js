const ROOT = "/studio";
// Agent workspace tabs. Build keeps the Factory namespace (/studio/factory/:id/...);
// the others live under /studio/products/:id/<tab>.
export const AGENT_TABS = Object.freeze(["build", "storefront", "versions", "readiness"]);
const PRODUCT_TABS = new Set(["storefront", "versions", "readiness"]);
// Older Product URLs open the Build tab of the same Agent.
const RETIRED_PRODUCT_TABS = new Set(["overview", "files", "about-you", "corpus", "brief", "complete", "test", "examples", "data-controls"]);
export const FACTORY_SECTION_AGENTS = Object.freeze({
  sources: Object.freeze(["research", "voice"]),
  build: Object.freeze(["generation"]),
  evaluate: Object.freeze(["case-generation", "evaluator"])
});
export const FACTORY_SECTION_PAGES = Object.freeze({
  sources: Object.freeze(["uploads"]),
  build: Object.freeze([]),
  evaluate: Object.freeze([])
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
  if (!FACTORY_SECTION_AGENTS[factorySection].includes(factoryAgent) && !FACTORY_SECTION_PAGES[factorySection].includes(factoryAgent)) throw new RangeError("Agent or page does not belong to Factory section");
  return `${sectionPath}/${factoryAgent}`;
}

/** The canonical URL of one Agent workspace tab. Build is the Factory path. */
export function creatorProductPath(productId, tab) {
  if (tab === undefined || tab === null || tab === "build") return creatorFactoryPath(productId);
  if (!PRODUCT_TABS.has(tab)) throw new RangeError("Unknown Agent tab");
  return `${ROOT}/products/${encodeURIComponent(productId)}/${tab}`;
}

const page = (kind, section, extra = {}) => ({ kind, section, ...extra });
const redirect = (to, section) => ({ kind: "redirect", section, to });

export function parseCreatorRoute(pathname) {
  const clean = `/${String(pathname ?? "").split(/[?#]/)[0].split("/").filter(Boolean).join("/")}`;
  if (clean !== ROOT && !clean.startsWith(`${ROOT}/`)) return page("not-found", "");
  const segments = clean.slice(ROOT.length).split("/").filter(Boolean).map(safeDecode);
  const [head, second, third, fourth] = segments;
  if (!segments.length) return page("home", "home");
  if (head === "factory") {
    if (segments.length === 1) return redirect(`${ROOT}/products`, "products");
    const productId = second;
    if (segments.length === 2) return page("agent", "products", { productId, tab: "build" });
    if (!Object.hasOwn(FACTORY_SECTION_AGENTS, third)) return page("not-found", "products");
    if (segments.length === 3) return page("agent", "products", { productId, tab: "build", factorySection: third });
    if (segments.length === 4 && (FACTORY_SECTION_AGENTS[third].includes(fourth) || FACTORY_SECTION_PAGES[third].includes(fourth))) {
      return page("agent", "products", { productId, tab: "build", factorySection: third, factoryAgent: fourth });
    }
    return page("not-found", "products");
  }
  if (head === "products") {
    if (segments.length === 1) return page("products", "products");
    if (second === "new" && segments.length === 2) return page("product-create", "products");
    const productId = second;
    if (segments.length === 2) return redirect(creatorFactoryPath(productId), "products");
    if (segments.length === 3 && PRODUCT_TABS.has(third)) return page("agent", "products", { productId, tab: third });
    if (segments.length === 3 && RETIRED_PRODUCT_TABS.has(third)) return redirect(creatorFactoryPath(productId), "products");
    if (segments.length === 3 && third === "preview") return redirect(creatorProductPath(productId, "storefront"), "products");
    if (segments.length === 4 && third === "releases") return page("agent", "products", { productId, tab: "versions", releaseId: fourth });
    if (segments.length === 4 && third === "candidates") return page("candidate", "products", { productId, candidateId: fourth });
    return page("not-found", "products");
  }
  if (head === "orders") {
    if (segments.length === 1) return page("orders", "orders");
    if (segments.length === 2) return page("order", "orders", { orderId: second });
    return page("not-found", "orders");
  }
  if (head === "earnings" && segments.length === 1) return page("earnings", "earnings");
  // The payout onboarding provider returns to /studio/payouts.
  if (head === "payouts" && segments.length === 1) return redirect(`${ROOT}/earnings`, "earnings");
  if (head === "settings" && segments.length === 1) return page("settings", "settings");
  return page("not-found", "");
}

export function creatorRouteTitle(route) {
  const titles = {
    home: "Overview", products: "Agents", "product-create": "New Agent", agent: "Agent", candidate: "Candidate review",
    orders: "Orders", order: "Order", earnings: "Earnings", settings: "Settings"
  };
  return titles[route.kind] ?? "Studio";
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}
