import { randomUUID } from "node:crypto";
import type { ArtifactObjectStore } from "../creatorLearning/objectStore.js";
import { renderFormPage } from "./inject.js";
import type { FormLinks } from "./links.js";
import type { FormOrigin, FormPage, FormRepository } from "./repository.js";
import { renderReview, type ReviewFile } from "./reviewFile.js";
import { FormInvalid, FormNotFound, checkAnswer, parseFormSchema, shownAnswerIds } from "./schema.js";

const HTML_MAX_BYTES = 2 * 1024 * 1024;

/** What happens in the conversation a form came from when the Expert submits it. */
export interface FormSubmissions {
  /** `review` is the answers as a file, for the conversation's workspace: where the agents read them. */
  submitted(page: Pick<FormPage, "id" | "accountId" | "title" | "origin" | "submittedAt">, review: ReviewFile): Promise<void>;
}

export type FormReading = { status: "open" | "submitted"; answers: Record<string, unknown>; submitted_at?: string };

/**
 * The agent's form pages: published as HTML, filled in by the Expert through a signed link, read back as a file in the agent's workspace.
 * The HTML lives in the object store, one immutable object per published version; answers live with the page's record.
 */
export class FormPages {
  constructor(private deps: { repository: FormRepository; store: ArtifactObjectStore; links: FormLinks; submissions: FormSubmissions; prefix?: string }) {}

  /** Publishes a new page, or a new version of one of the owner's own (`formId`): same id and link, the answers kept by question id. */
  async publish(owner: { accountId: string } & FormOrigin, input: { formId?: string; title: string; html: string; schema: unknown }): Promise<{ form_id: string; url: string }> {
    const schema = parseFormSchema(input.schema);
    const title = input.title.trim();
    if (!title) throw new FormInvalid("title is required");
    if (!input.html.trim() || Buffer.byteLength(input.html) > HTML_MAX_BYTES) throw new FormInvalid("html must be a full page of at most 2MB");
    // A page whose buttons call nothing would look finished and do nothing: refuse it, and say how to fix it.
    const unwired = ["hatch.save", "hatch.submit"].filter(call => !input.html.includes(call));
    if (unwired.length) throw new FormInvalid(`The page never calls ${unwired.map(call => `${call}()`).join(" or ")}, so its fields and buttons would do nothing. Read input/reference/review-page.html and keep its script: it renders the questions from window.hatch.schema, autosaves, and submits.`);
    const { accountId, ...origin } = owner;
    const existing = input.formId ? await this.owned(accountId, input.formId) : undefined;
    const id = existing?.id ?? randomUUID();
    const version = (existing?.version ?? 0) + 1;
    const htmlKey = `${this.deps.prefix ?? "form-pages"}/${id}/${version}.html`;
    await this.deps.store.put(htmlKey, input.html, { contentType: "text/html; charset=utf-8", immutable: true });
    if (!existing) await this.deps.repository.create({ id, accountId, title, htmlKey, schema, origin });
    else if (!await this.deps.repository.revise(id, existing.version, { title, htmlKey, schema, origin })) throw new FormInvalid("这张表单刚被改过，请再发布一次");
    return { form_id: id, url: this.deps.links.url(id, accountId) };
  }

  /** What the Expert has answered so far: the answers to the questions the page shows now. Agents do not call this; they read the review file written at submit. */
  async read(accountId: string, formId: string): Promise<FormReading> {
    const page = await this.owned(accountId, formId);
    const shown = shownAnswerIds(page.schema);
    const answers: Record<string, unknown> = {};
    for (const answer of await this.deps.repository.answers(formId)) if (answer.value !== null && shown.has(answer.questionId)) answers[answer.questionId] = answer.value;
    return { status: page.status, answers, ...(page.submittedAt ? { submitted_at: page.submittedAt } : {}) };
  }

  // The Expert's side: the link is the credential.

  /** The page as the Expert opens it: the agent's HTML with Hatch's styles, the current answers and the client. */
  async open(formId: string, token: string | null): Promise<string> {
    const page = await this.linked(formId, token);
    const html = (await this.deps.store.get(page.htmlKey)).toString("utf8");
    const shown = shownAnswerIds(page.schema);
    const answers: Record<string, unknown> = {};
    const versions: Record<string, number> = {};
    for (const answer of await this.deps.repository.answers(formId)) {
      versions[answer.questionId] = answer.version;
      if (answer.value !== null && shown.has(answer.questionId)) answers[answer.questionId] = answer.value;
    }
    return renderFormPage(html, { formId, token: token!, schema: page.schema, answers, versions, status: page.status });
  }

  /** Stores (or, with a null value, clears) one answer. Returns its new version. */
  async save(formId: string, token: string | null, answerId: string, value: unknown, base: number): Promise<{ version: number }> {
    const page = await this.linked(formId, token);
    if (value !== null) checkAnswer(page.schema, answerId, value);
    else if (!shownAnswerIds(page.schema).has(answerId)) throw new FormInvalid(`没有这道题：${answerId}`);
    return { version: (await this.deps.repository.save(formId, answerId, value, base)).version };
  }

  /** Closes the page and tells the conversation it came from. A retry after a failed notice sends the notice again, never twice. */
  async submit(formId: string, token: string | null): Promise<void> {
    await this.linked(formId, token);
    const { page } = await this.deps.repository.submit(formId);
    if (page.notifiedAt) return;
    await this.deps.submissions.submitted(page, renderReview(page, page.schema, (await this.read(page.accountId, formId)).answers));
    await this.deps.repository.notified(formId);
  }

  private async owned(accountId: string, formId: string): Promise<FormPage> {
    const page = await this.deps.repository.get(formId);
    if (!page || page.accountId !== accountId) throw new FormNotFound();
    return page;
  }

  private async linked(formId: string, token: string | null): Promise<FormPage> {
    const page = await this.deps.repository.get(formId);
    if (!page || !this.deps.links.verify(formId, page.accountId, token)) throw new FormNotFound();
    return page;
  }
}
