// The guided path an Expert walks to build an Agent: upload, interview, build, then publish.
// Each step groups the real Factory Agents (by role) and pages that already exist in the Factory routes;
// state is derived only from the live Factory snapshot and the Product status.
export const STUDIO_PATH = Object.freeze([
  { id: "upload", title: "stepRead", body: "stepReadBody", key: "uploads", items: [["sources", "uploads"]] },
  { id: "ask", title: "stepAsk", body: "stepAskBody", key: "voice", items: [["sources", "voice"]] },
  { id: "build", title: "stepBuild", body: "stepBuildBody", key: "generation", items: [["build", "generation"]] },
  { id: "ship", title: "stepShip", body: "stepShipBody", key: null, items: [] }
]);

/** Rail rows outside the numbered path: no state, no progress. Deep Research is not listed: the Assistant runs it in the background. */
export const CONTENT_STEP = Object.freeze({ id: "content", title: "stepContent", items: [["create", "content-creation"]] });
export const CASES_STEP = Object.freeze({ id: "cases", title: "stepCases", items: [["evaluate", "case-generation"]] });
export const EVALUATOR_STEP = Object.freeze({ id: "evaluator", title: "stepEvaluator", items: [["evaluate", "evaluator"]] });
/** Under the Advanced disclosure, in order. */
export const ADVANCED_STEPS = Object.freeze([CASES_STEP, EVALUATOR_STEP]);

export const INSPIRATION_STEP = Object.freeze({ id: "inspiration", title: "stepInspiration", items: [["inspire", "inspiration"]] });

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
  if (page === "inspiration") return INSPIRATION_STEP.id;
  if (page === "content-creation") return CONTENT_STEP.id;
  if (page === "case-generation") return CASES_STEP.id;
  if (page === "evaluator") return EVALUATOR_STEP.id;
  if (section === "sources") return page === "voice" ? "ask" : "upload";
  if (section === "build") return "build";
  return null;
}
