export const CREATOR_WORKFLOW_STEPS = ["files", "about-you", "review", "brief", "complete"];

const FACTORY_WORKING_STATUSES = new Set(["queued", "running"]);
const FACTORY_GENERATION_STAGES = new Set([
  "extracting_evidence",
  "compiling_corpus",
  "evaluating_development",
  "evaluating_regression",
  "evaluating_heldout"
]);

/**
 * Derive the Creator-facing workflow from the durable Product run and
 * release artifacts. Local `busy` state is accepted only as a short-lived
 * optimistic hint before the server returns the durable run checkpoint.
 */
export function deriveCreatorWorkflow({ run, review, briefSpec, busy = "" } = {}) {
  const generationStep = run?.workflow_step ?? workflowStepFallback(run);
  const serverWorking = FACTORY_WORKING_STATUSES.has(run?.status);
  const transientWorking = Boolean(busy && ["start", "answer", "retry-run", "rerun"].includes(busy));
  const working = serverWorking || transientWorking;
  const failed = isNeedsAttention(run);
  const releaseReady = review?.release_ready === true;
  const briefValid = isValidBriefSpec(briefSpec);
  const current = working || failed
    ? generationStep
    : releaseReady
      ? (briefValid ? "complete" : "brief")
      : run?.status === "waiting_for_creator" && run?.stage === "awaiting_creator_answers"
        ? "about-you"
        : run?.stage === "review_required" || run?.status === "ready" || Boolean(review)
          ? "review"
          : generationStep;
  const currentIndex = Math.max(0, CREATOR_WORKFLOW_STEPS.indexOf(current));
  const steps = Object.fromEntries(CREATOR_WORKFLOW_STEPS.map((step, index) => {
    const isCurrent = step === current;
    const enabled = working
      ? isCurrent
      : index <= currentIndex;
    return [step, {
      enabled,
      current: isCurrent,
      loading: isCurrent && working,
      failed: isCurrent && failed,
      complete: index < currentIndex
    }];
  }));

  return {
    current,
    generationStep,
    working,
    failed,
    releaseReady,
    briefValid,
    steps
  };
}

export function isValidBriefSpec(briefSpec) {
  if (!Array.isArray(briefSpec?.fields) || briefSpec.fields.length === 0 || briefSpec.fields.length > 16) return false;
  const ids = new Set();
  return briefSpec.fields.every((field, index) => {
    const id = String(field?.id ?? `question-${index + 1}`);
    const label = String(field?.label ?? "").trim();
    if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(id) || ids.has(id)) return false;
    ids.add(id);
    return Boolean(label) && label.length <= 500 && typeof field?.required === "boolean";
  });
}

export function isFactoryWorking(run) {
  return FACTORY_WORKING_STATUSES.has(run?.status);
}

function isNeedsAttention(run) {
  return !isFactoryWorking(run) && (run?.status === "needs_attention" || run?.stage === "needs_attention");
}

function workflowStepFallback(run) {
  if (!run) return "files";
  // The public contract normally supplies workflow_step.  This fallback is
  // only for older runtimes that do not, so prefer the normal Product path for
  // generation stages; a review rerun is identified by the server's explicit
  // retry_stage/workflow_step once the current contract is available.
  const revision = Boolean(run.parent_revision_id || run.revision_number > 1);
  if (run.status === "needs_attention") return stepForStage(run.retry_stage ?? run.stage, revision, run);
  if (isFactoryWorking(run)) {
    if (run.pending_answers) return "about-you";
    return stepForStage(run.stage, false, run);
  }
  if (run.stage === "awaiting_creator_answers") return "about-you";
  if (run.stage === "review_required" || run.status === "ready") return "review";
  return stepForStage(run.stage, false, run);
}

function stepForStage(stage, revision, run) {
  if (stage === "extracting_evidence") return "files";
  if (stage === "awaiting_creator_answers") return "about-you";
  if (FACTORY_GENERATION_STAGES.has(stage)) return revision ? "review" : "about-you";
  if (stage === "review_required" || stage === "ready") return "review";
  if (stage === "needs_attention") return revision ? "review" : (run?.pending_questions?.length ? "about-you" : "files");
  return revision ? "review" : "files";
}
