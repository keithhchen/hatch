export const CREATOR_WORKFLOW_STEPS = ["files", "about-you", "review", "brief", "complete"];

const FACTORY_WORKING_STATUSES = new Set(["queued", "running"]);
const FACTORY_GENERATION_STAGES = new Set([
  "extracting_evidence",
  "compiling_corpus",
  "evaluating_development",
  "evaluating_regression",
  "evaluating_heldout"
]);

const WORKFLOW_STEP_ALIASES = {
  files: "files",
  files_generation: "files",
  "files-generation": "files",
  "about-you": "about-you",
  about_you: "about-you",
  about_you_generation: "about-you",
  "about-you-generation": "about-you",
  review: "review",
  review_generation: "review",
  "review-generation": "review",
  brief: "brief",
  complete: "complete"
};

const FACTORY_STAGE_STEP_ALIASES = {
  files_generation: "files",
  "files-generation": "files",
  about_you_generation: "about-you",
  "about-you-generation": "about-you",
  review_generation: "review",
  "review-generation": "review"
};

const PRODUCT_PUBLISH_FAILURE_STATUSES = new Set([
  "publish_error",
  "publish_failed",
  "publishing_failed"
]);

/**
 * Derive the Creator-facing workflow from the durable Product run and
 * release artifacts. Generation state is intentionally server-only: a local
 * button spinner must never decide which tab is current or enabled, because
 * that state must survive refreshes and process restarts.
 */
export function deriveCreatorWorkflow({ run, review, briefSpec, product } = {}) {
  const generationStep = normalizeWorkflowStep(run?.workflow_step) ?? workflowStepFallback(run);
  const serverWorking = FACTORY_WORKING_STATUSES.has(run?.status);
  const working = serverWorking;
  const failed = isNeedsAttention(run);
  const productStatus = String(product?.status ?? "").trim().toLowerCase();
  const publishing = productStatus === "publishing";
  const publishFailed = PRODUCT_PUBLISH_FAILURE_STATUSES.has(productStatus);
  const published = productStatus === "published";
  const reviewMatchesRun = isReviewForRun(run, review);
  const releaseReady = reviewMatchesRun && review?.release_ready === true;
  const briefValid = isValidBriefSpec(briefSpec);
  const awaitingCreator = run?.status === "waiting_for_creator"
    && (run?.stage === "awaiting_creator_answers" || generationStep === "about-you");
  const reviewCheckpoint = Boolean(run)
    && !awaitingCreator
    && (run?.status === "ready" || run?.stage === "review_required" || run?.stage === "ready" || generationStep === "review");
  const current = publishing || publishFailed
    ? "complete"
    : working || failed
    ? generationStep
    : awaitingCreator
      ? "about-you"
      : published
        ? "complete"
        : reviewCheckpoint
        ? (releaseReady ? (briefValid ? "complete" : "brief") : "review")
        : generationStep;
  const currentIndex = Math.max(0, CREATOR_WORKFLOW_STEPS.indexOf(current));
  const steps = Object.fromEntries(CREATOR_WORKFLOW_STEPS.map((step, index) => {
    const isCurrent = step === current;
    const enabled = publishing
      ? isCurrent
      : working
      ? isCurrent
      : index <= currentIndex;
    return [step, {
      enabled,
      current: isCurrent,
      loading: isCurrent && (working || publishing),
      locked: publishing,
      failed: isCurrent && (failed || publishFailed),
      complete: index < currentIndex
    }];
  }));

  return {
    current,
    generationStep,
    working,
    failed,
    publishing,
    publishFailed,
    published,
    reviewMatchesRun,
    reviewCheckpoint,
    releaseReady,
    briefValid,
    steps
  };
}

/**
 * The Registry contract emits one of the five dashboard steps. Keep a small
 * compatibility alias table for older deployments, but never let an unknown
 * value become an invisible active tab with no loading/error surface.
 */
export function normalizeWorkflowStep(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return WORKFLOW_STEP_ALIASES[normalized] ?? null;
}

/**
 * Review is a projection of one immutable run. A review response left in
 * React state must not unlock Brief or Complete after the selected run has
 * changed, or after a new candidate replaced the old digest.
 */
export function isReviewForRun(run, review) {
  if (!run?.id || !review) return false;
  const reviewRunId = review.run_id ?? review.runId;
  if (!reviewRunId || String(reviewRunId) !== String(run.id)) return false;
  const candidateDigest = run.candidate?.system_digest ?? run.candidate?.systemDigest;
  const reviewDigest = review.candidate_digest ?? review.candidateDigest;
  if (reviewDigest && !candidateDigest) return false;
  return !reviewDigest || reviewDigest === candidateDigest;
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
  const normalizedStage = String(stage ?? "").trim().toLowerCase();
  const aliasedStep = FACTORY_STAGE_STEP_ALIASES[normalizedStage];
  if (aliasedStep) return aliasedStep;
  if (normalizedStage === "extracting_evidence") return "files";
  if (normalizedStage === "awaiting_creator_answers") return "about-you";
  if (FACTORY_GENERATION_STAGES.has(normalizedStage)) return revision ? "review" : "about-you";
  if (normalizedStage === "review_required" || normalizedStage === "ready") return "review";
  if (normalizedStage === "needs_attention") return revision ? "review" : (run?.pending_questions?.length ? "about-you" : "files");
  return revision ? "review" : "files";
}
