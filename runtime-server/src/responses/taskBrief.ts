import { BriefValidationError, createBriefSnapshot, type BriefSnapshot, type BriefSpec } from "../brief.js";
import { invalidRequest } from "./errors.js";

/**
 * A `task_brief` object `{ "<field id>": "<value>" }` as the Product's Brief rules see it. The rules are the domain's
 * (`createBriefSnapshot`); this only translates the shape and names the field a refusal is about.
 * A Product without a Brief takes none; one with a Brief always gets its snapshot, as on every other surface.
 */
export function taskBriefSnapshot(spec: BriefSpec | undefined, taskBrief: unknown): BriefSnapshot | undefined {
  if (taskBrief === undefined || taskBrief === null) {
    if (!spec) return undefined;
  } else if (typeof taskBrief !== "object" || Array.isArray(taskBrief)) {
    throw invalidRequest("invalid_task_brief", "task_brief must be an object of field id to value.", "task_brief");
  } else if (!spec) {
    throw invalidRequest("invalid_task_brief", "This model has no Task Brief.", "task_brief");
  }
  const given = (taskBrief ?? {}) as Record<string, unknown>;
  const answers = Object.entries(given).map(([field_id, value]) => {
    if (typeof value !== "string") throw invalidRequest("invalid_task_brief", `task_brief.${field_id} must be a string.`, `task_brief.${field_id}`);
    return { field_id, value };
  });
  try {
    return createBriefSnapshot(spec, answers);
  } catch (error) {
    if (!(error instanceof BriefValidationError)) throw error;
    if (error.code === "brief_required_answer_missing") {
      const missing = spec!.fields.filter((field) => field.required && !given[field.id]?.toString().trim());
      throw invalidRequest("task_brief_required", `task_brief must answer: ${missing.map((field) => `${field.id} (${field.label})`).join("; ")}`, `task_brief.${missing[0]?.id ?? ""}`);
    }
    const unknown = answers.find((answer) => !spec!.fields.some((field) => field.id === answer.field_id));
    throw invalidRequest("invalid_task_brief", unknown ? `task_brief has no field ${unknown.field_id}.` : error.message, unknown ? `task_brief.${unknown.field_id}` : "task_brief");
  }
}

/** The snapshot as the API shows it: each field with the value it was answered with. */
export const taskBriefObject = (snapshot: BriefSnapshot | undefined) =>
  snapshot ? { fields: snapshot.fields.map(({ id, label, required, value }) => ({ id, label, required, value })) } : null;
