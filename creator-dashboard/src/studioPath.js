// The guided path an Expert walks to build an Agent: upload, interview, build, then publish.
// Each step groups the real Factory Agents (by role) and pages that already exist in the Factory routes;
// state is derived only from the live Factory snapshot and the Product status.
export const STUDIO_PATH = Object.freeze([
  { id: "upload", title: "stepRead", body: "stepReadBody", key: "uploads", items: [["sources", "uploads"]] },
  { id: "ask", title: "stepAsk", body: "stepAskBody", key: "voice", items: [["sources", "voice"]] },
  { id: "build", title: "stepBuild", body: "stepBuildBody", key: "generation", items: [["build", "generation"]] },
  { id: "ship", title: "stepShip", body: "stepShipBody", key: null, items: [] }
]);

/** Deep Research, Case Builder and Evaluator: always open, never part of the path's progress. */
export const ADVANCED_STEP = Object.freeze({
  id: "advanced", title: "stepAdvanced", items: [["sources", "research"], ["evaluate", "case-generation"], ["evaluate", "evaluator"]]
});

export function isProductLive(product) {
  return product?.status === "published" || product?.status === "live";
}

const DONE = new Set(["complete", "update_available"]);

/** One of: done, running, todo, locked — never guessed when data is missing. */
export function studioStepState(step, agents = [], product = null, manualFiles = []) {
  if (step.id === "ship") return isProductLive(product) ? "done" : "todo";
  if (step.id === "upload") return manualFiles.length ? "done" : "todo";
  const entry = agents.find((agent) => agent.role === step.key);
  if (!entry) return "todo";
  if (entry.state === "running") return "running";
  if (DONE.has(entry.state)) return "done";
  return entry.state === "locked" ? "locked" : "todo";
}

export function studioPathStates(agents = [], product = null, manualFiles = []) {
  return STUDIO_PATH.map((step) => ({ step, state: studioStepState(step, agents, product, manualFiles) }));
}

/** The first step that is not done; null when the whole path is done. */
export function studioNextStep(states) {
  return states.find((item) => item.state !== "done" && item.state !== "locked")
    ?? states.find((item) => item.state !== "done")
    ?? null;
}

export function studioStepForRoute(section, page) {
  if (ADVANCED_STEP.items.some(([, role]) => role === page)) return "advanced";
  if (section === "sources") return page === "voice" ? "ask" : "upload";
  if (section === "build") return "build";
  return null;
}
