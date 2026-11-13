import { z } from "zod";

/** The id of a question, stable across edits: answers are matched by it. `__note` is reserved for the side note of a choice. */
const questionId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "question id must be 1-40 letters, digits, - or _").refine(id => !id.includes("__"), "question id must not contain __");

const question = z.object({
  id: questionId,
  group: z.string().max(200).optional(),
  type: z.enum(["open", "choice", "multi"]),
  title: z.string().min(1).max(300),
  scenario: z.string().max(4000).optional(),
  prompt: z.string().min(1).max(2000),
  options: z.array(z.string().min(1).max(300)).max(30).optional(),
}).strict();

export const formSchema = z.object({ questions: z.array(question).min(1).max(200) }).strict().superRefine((schema, context) => {
  const seen = new Set<string>();
  for (const [index, item] of schema.questions.entries()) {
    if (seen.has(item.id)) context.addIssue({ code: "custom", path: ["questions", index, "id"], message: `question ids must be unique: ${item.id}` });
    seen.add(item.id);
    if (item.type !== "open" && !(item.options && new Set(item.options).size === item.options.length && item.options.length >= 2)) {
      context.addIssue({ code: "custom", path: ["questions", index, "options"], message: `${item.id}: ${item.type} questions need at least 2 distinct options` });
    }
  }
});

export type FormQuestion = z.infer<typeof question>;
export type FormSchema = z.infer<typeof formSchema>;

/** The schema as the agent wrote it, or why not, in words the agent can act on. */
export function parseFormSchema(value: unknown): FormSchema {
  const parsed = formSchema.safeParse(value);
  if (!parsed.success) throw new FormInvalid(parsed.error.issues.map(issue => `${issue.path.join(".") || "schema"}: ${issue.message}`).join("; "));
  return parsed.data;
}

const NOTE = "__note";

/** What one answer may be, given the current schema. The side note of a question is `<id>__note`. Throws FormInvalid. */
export function checkAnswer(schema: FormSchema, answerId: string, value: unknown): void {
  const isNote = answerId.endsWith(NOTE);
  const item = schema.questions.find(candidate => candidate.id === (isNote ? answerId.slice(0, -NOTE.length) : answerId));
  if (!item) throw new FormInvalid(`没有这道题：${answerId}`);
  const text = (max: number) => { if (typeof value !== "string" || value.length > max) throw new FormInvalid(`${answerId} 需要不超过 ${max} 字的文字`); };
  if (isNote) { if (item.type === "open") throw new FormInvalid(`${item.id} 是开放题，没有补充说明`); return text(5000); }
  if (item.type === "open") return text(20000);
  const options = new Set(item.options);
  if (item.type === "choice") { text(300); if (!options.has(value as string)) throw new FormInvalid(`${answerId} 的选项已经改了，请刷新页面`); return; }
  if (!Array.isArray(value) || value.length > options.size || value.some(entry => typeof entry !== "string" || !options.has(entry))) throw new FormInvalid(`${answerId} 的选项已经改了，请刷新页面`);
}

/** The answer ids a schema shows: each question and its note. */
export const shownAnswerIds = (schema: FormSchema): Set<string> => new Set(schema.questions.flatMap(item => item.type === "open" ? [item.id] : [item.id, `${item.id}${NOTE}`]));

/** A request the agent or the page can fix. */
export class FormInvalid extends Error { readonly status = 400; }
/** The page was submitted: it is read-only now. */
export class FormClosed extends Error { readonly status = 409; constructor() { super("表单已提交，不能再修改"); } }
/** The page was changed elsewhere since it was loaded. `current` is what is stored now. */
export class FormConflict extends Error { readonly status = 409; constructor(readonly current: { value: unknown; version: number }) { super("这一题在别处被改过了，请刷新页面后再保存"); } }
/** No such page, or the link does not open it. Both read the same. */
export class FormNotFound extends Error { readonly status = 404; constructor() { super("找不到这张表单"); } }
