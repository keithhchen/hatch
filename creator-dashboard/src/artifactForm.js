// Pure rules of the artifact intake: counting, validation, form.md. No DOM, no network.
// The UI cap on user files; form.md comes on top. The Runtime enforces its own cap.
export const MAX_INTAKE_FILES = 20;
export const FORM_FILE_NAME = "form.md";

const FALLBACK = ["en", "zh", "ja"];
/** A localized text in the reader's language, else the first one given. */
export const localized = (text, locale) => typeof text === "string" ? text : (text?.[locale] ?? FALLBACK.map(code => text?.[code]).find(Boolean) ?? "");
/** The intake as the reader sees it: every label, help and option in their language. Answers carry the text they chose. */
export const localizeIntake = (intake, locale) => ({
  ...intake,
  fields: intake.fields.map(field => ({
    ...field,
    label: localized(field.label, locale),
    ...(field.help !== undefined ? { help: localized(field.help, locale) } : {}),
    ...(field.options ? { options: field.options.map(option => localized(option, locale)) } : {})
  }))
});
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const MEDIA_TYPES = Object.freeze({
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", heic: "image/heic"
});
export const INTAKE_FILE_ACCEPT = "image/*,.pdf,.doc,.docx";

/** The file's own type, or the one its extension names (phones often leave docx empty). */
export const fileMediaType = file => file.type || MEDIA_TYPES[file.name.split(".").pop().toLowerCase()] || "application/octet-stream";
export const isAcceptedFile = file => fileMediaType(file).startsWith("image/") || ["application/pdf", MEDIA_TYPES.doc, MEDIA_TYPES.docx].includes(fileMediaType(file));

const text = value => (Array.isArray(value) ? value.join("、") : String(value ?? "")).trim();
const filesOf = (files, field) => files?.[field.id] ?? [];

/** A field is answered by typed text, a pick, or (files fields) at least one file. */
export const isAnswered = (field, answers, files) => Boolean(text(answers[field.id])) || (field.type === "files" && filesOf(files, field).length > 0);

export const answeredCount = (fields, answers, files) => fields.filter(field => isAnswered(field, answers, files)).length;

export const fileCount = (fields, files) => fields.reduce((total, field) => total + filesOf(files, field).length, 0);

/** Problems that stop a submit: `{ field, code }` with code "required" or "fileLimit". A typed "暂无" is a real answer. */
export function validateIntake(fields, answers, files) {
  const problems = fields.filter(field => field.required && !isAnswered(field, answers, files)).map(field => ({ field: field.id, code: "required" }));
  if (fileCount(fields, files) > MAX_INTAKE_FILES) problems.push({ field: null, code: "fileLimit" });
  return problems;
}

export const ATTACHMENTS_DIR = "/attachments/";

/** `name` made unique among `taken` the way the Runtime's flat file view does: " (2)", " (3)" before the extension. */
export function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The names the Runtime will show for files uploaded in this order. */
export function assignNames(names) {
  const taken = new Set();
  return names.map(name => { const unique = uniqueName(name, taken); taken.add(unique); return unique; });
}

/**
 * form.md: the product name, each answered field as `## label` with its answer (a files field ends with its file paths),
 * then `## Files`: every file of the conversation by the path the Agent will see, with the question it answers.
 * `fileNames` are the final unique upload names per files field.
 */
export function buildFormMd(productName, fields, answers, fileNames = {}) {
  const path = name => `${ATTACHMENTS_DIR}${name}`;
  const sections = fields.flatMap(field => {
    const body = [text(answers[field.id]), ...(fileNames[field.id] ?? []).map(name => `- ${path(name)}`)].filter(Boolean).join("\n");
    return body ? [`## ${field.label}\n\n${body}`] : [];
  });
  const listing = [`- ${path(FORM_FILE_NAME)}`, ...fields.flatMap(field => (fileNames[field.id] ?? []).map(name => `- ${path(name)} (${field.label})`))];
  return [`# ${productName}`, ...sections, `## Files\n\n${listing.join("\n")}`].join("\n\n") + "\n";
}

/**
 * Local autosave of typed answers per product, and the submission key: made when Submit is first pressed and kept until the
 * submission succeeds, so a double click, a refresh or a retry is the same submission. Storage may be absent or throw:
 * then nothing is kept and nothing breaks.
 */
export function draftStore(storage, productId) {
  const key = `hatch.artifact.draft.${productId}`;
  const submissionItem = `hatch.artifact.submission.${productId}`;
  return {
    load() { try { return JSON.parse(storage.getItem(key)) ?? {}; } catch { return {}; } },
    save(answers) { try { storage.setItem(key, JSON.stringify(answers)); } catch { /* the draft is a convenience */ } },
    submissionKey(generate) {
      try {
        const existing = storage.getItem(submissionItem);
        if (existing) return existing;
        const created = generate();
        storage.setItem(submissionItem, created);
        return created;
      } catch { return generate(); }
    },
    clear() { try { storage.removeItem(key); storage.removeItem(submissionItem); } catch { /* nothing to clear */ } }
  };
}

/** What the page shows, from the Runtime's reports (newest first) and the routed conversation: never from local assumptions. */
export function resumeView(reports, routedConversationId, { startNew = false } = {}) {
  const entry = routedConversationId ? reports.find(report => report.conversation_id === routedConversationId) : reports[0];
  if (routedConversationId && !entry) return { view: "report", conversationId: routedConversationId };
  if (entry && entry.status !== "draft" && !(startNew && !routedConversationId)) return { view: "report", conversationId: entry.conversation_id };
  const draft = entry?.status === "draft" ? entry : null;
  return { view: "intake", draftConversationId: draft?.conversation_id ?? null };
}

/** The ids derived from a submission key, so a resent first message is the same message of the same run. */
export const submissionIds = key => ({ clientMessageId: `message_${key}`, runId: `run_${key}` });

/** A report the Runtime is still working on (the stage says where). */
export const isWaiting = report => report.status === "generating" || report.status === "queued";

/** 3:07 for a report that has been generating that long. */
export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The steps a report goes through, in the order a reader is told them; each is a stage the Runtime records. */
export const REPORT_STEPS = ["reading", "consulting", "researching", "writing", "proofreading", "rendering"];
/** How far a report has come: the furthest step it has reached, so a step taken again (reading after writing) never moves it back. */
export function reportStep(report) {
  const seen = [report.stage, ...(report.steps ?? []).map(step => step.stage)].map(stage => REPORT_STEPS.indexOf(stage));
  return Math.max(0, ...seen) + 1;
}

/** An unknown id, or someone else's conversation: the server answers not found or forbidden, and asking again changes nothing. */
export const isMissingReport = error => error?.status === 404 || error?.status === 403;
