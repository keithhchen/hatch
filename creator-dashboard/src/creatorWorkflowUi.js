export const CREATOR_WORKFLOW_STEPS = ["files", "about-you", "corpus", "brief", "complete"];

const ACTIVE = new Set(["queued", "running"]);
const TERMINAL_ERRORS = new Set(["failed", "max_rounds"]);

/** Product workflow is a projection of server facts, never React busy state. */
export function deriveCreatorWorkflow({ product, documents = [], aboutYou, corpus, briefSpec } = {}) {
  const hasFiles = documents.some((file) => file?.status !== "deleted" && file?.status !== "error");
  const aboutYouState = String(aboutYou?.status ?? "");
  const corpusState = String(corpus?.status ?? "");
  const aboutYouDone = ["waiting_for_creator", "handoff_saved", "completed"].includes(aboutYouState);
  const answersSaved = aboutYouState === "handoff_saved" || Boolean(aboutYou?.handoff_ref);
  const corpusDone = corpusState === "completed" && Boolean(corpus?.output_ref);
  const briefValid = isValidBriefSpec(briefSpec);
  const productStatus = String(product?.status ?? "").toLowerCase();
  const publishing = productStatus === "publishing";
  const published = productStatus === "published";
  const failed = isExecutionError(aboutYou) || isExecutionError(corpus)
    || ["publish_error", "publish_failed", "publishing_failed"].includes(productStatus);

  let current = "files";
  if (published || publishing) current = "complete";
  else if (isExecutionError(corpus) || ACTIVE.has(corpusState)) current = "corpus";
  else if (isExecutionError(aboutYou) || ACTIVE.has(aboutYouState) || (aboutYouDone && !answersSaved)) current = "about-you";
  else if (!hasFiles || !aboutYou) current = "files";
  else if (!answersSaved) current = "about-you";
  else if (!corpusDone) current = "corpus";
  else if (!briefValid) current = "brief";
  else current = "complete";

  const currentIndex = CREATOR_WORKFLOW_STEPS.indexOf(current);
  const steps = Object.fromEntries(CREATOR_WORKFLOW_STEPS.map((step, index) => {
    const isCurrent = step === current;
    const enabled = publishing
      ? isCurrent
      : step === "files"
        ? true
        : step === "about-you"
          ? hasFiles
          : step === "corpus"
            ? answersSaved
            : step === "brief"
              ? corpusDone
              : corpusDone && briefValid;
    return [step, {
      enabled,
      current: isCurrent,
      loading: isCurrent && (ACTIVE.has(aboutYouState) || ACTIVE.has(corpusState) || publishing),
      failed: isCurrent && failed,
      locked: publishing,
      complete: index < currentIndex
    }];
  }));

  return {
    current,
    working: ACTIVE.has(aboutYouState) || ACTIVE.has(corpusState),
    publishing,
    published,
    failed,
    answersSaved,
    corpusDone,
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

export function isExecutionActive(execution) {
  return ACTIVE.has(String(execution?.status ?? ""));
}

export function isExecutionError(execution) {
  return TERMINAL_ERRORS.has(String(execution?.status ?? ""));
}

export function executionError(execution) {
  return String(execution?.last_error ?? "").trim() || null;
}
