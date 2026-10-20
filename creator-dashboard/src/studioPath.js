// The guided path an Expert walks to build an Agent. Each step groups the real
// Factory Agents (by role) and pages that already exist in the Factory routes;
// state is derived only from the live Factory snapshot and the Product status.
export const STUDIO_PATH = Object.freeze([
  { id: "read", title: "stepRead", body: "stepReadBody", photo: "l_read", key: "research", items: [["sources", "research"], ["sources", "uploads"]] },
  { id: "ask", title: "stepAsk", body: "stepAskBody", photo: "l_voice", key: "voice", items: [["sources", "voice"]] },
  { id: "build", title: "stepBuild", body: "stepBuildBody", photo: "mem", key: "generation", items: [["build", "generation"]] },
  { id: "test", title: "stepTest", body: "stepTestBody", photo: "l_eval", key: "evaluator", items: [["evaluate", "case-generation"], ["evaluate", "evaluator"]] },
  { id: "ship", title: "stepShip", body: "stepShipBody", photo: "l_live", key: null, items: [] }
]);

export const studioPhoto = (id) => `/assets/web/photos/${id}.jpg`;

export function isProductLive(product) {
  return product?.status === "published" || product?.status === "live";
}

const DONE = new Set(["complete", "update_available"]);

/** One of: done, running, todo, locked — never guessed when data is missing. */
export function studioStepState(step, agents = [], product = null) {
  if (step.id === "ship") return isProductLive(product) ? "done" : "todo";
  const roles = step.items.map(([, role]) => role);
  const entries = agents.filter((agent) => roles.includes(agent.role));
  if (!entries.length) return "todo";
  if (entries.some((agent) => agent.state === "running")) return "running";
  if (DONE.has(entries.find((agent) => agent.role === step.key)?.state)) return "done";
  if (entries.every((agent) => agent.state === "locked")) return "locked";
  return "todo";
}

export function studioPathStates(agents = [], product = null) {
  return STUDIO_PATH.map((step) => ({ step, state: studioStepState(step, agents, product) }));
}

/** The first step that is not done; null when the whole path is done. */
export function studioNextStep(states) {
  return states.find((item) => item.state !== "done" && item.state !== "locked")
    ?? states.find((item) => item.state !== "done")
    ?? null;
}

export function studioStepForRoute(section, page) {
  if (section === "sources") return page === "voice" ? "ask" : "read";
  if (section === "build") return "build";
  if (section === "evaluate") return "test";
  return null;
}
