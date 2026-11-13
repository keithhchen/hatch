import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { result } from "../factoryAgents/files.js";
import type { WorkbenchStore } from "../factoryAgents/store.js";
import type { FormPages } from "./service.js";

export const FORM_TOOLS = ["publish_form", "read_form"];
/** Where the reference page is for the voice session's `read` tool. */
export const REFERENCE_PATH = "input/reference/review-page.html";
const REFERENCE = new URL("../../prompts/factory-agents/voice/form-reference/review-page.html", import.meta.url);

/** Puts the reference page in the session's files, read-only, so `read` opens it at REFERENCE_PATH. Written again only when it changed. */
export async function provideFormReference(store: WorkbenchStore, id: string): Promise<void> {
  const bytes = await readFile(fileURLToPath(REFERENCE));
  if ((await store.read(id, REFERENCE_PATH).catch(() => undefined))?.bytes.equals(bytes)) return;
  await store.put(id, REFERENCE_PATH, bytes, { actor: "host", readonly: true, mimeType: "text/html", countsAsOutput: false });
}

const question = Type.Object({
  id: Type.String({ description: "Stable id such as C01. Never renumber when editing; answers are matched by it." }),
  group: Type.Optional(Type.String()),
  type: Type.Union([Type.Literal("open"), Type.Literal("choice"), Type.Literal("multi")], { description: "open = free text, choice = pick one option, multi = pick several. Nothing else is valid." }),
  title: Type.String(),
  scenario: Type.Optional(Type.String({ description: "Background: the expert's own words quoted from the chat or materials." })),
  prompt: Type.String({ description: "One clear question." }),
  options: Type.Optional(Type.Array(Type.String(), { description: "Required for choice and multi." })),
});

/**
 * The voice session's form page tools. `session` is the session they serve: a page belongs to its Expert and remembers
 * which conversation published it (this session, or the Assistant task it was working for) so its submission can continue there.
 */
export function formTools(forms: FormPages, session: { accountId: string; productId: string; sessionId: string; taskId: () => Promise<string | undefined> }): AgentTool[] {
  return [
    {
      name: "publish_form", label: "发布审阅页",
      description: `Publish or update this expert's review page and get its link. Write the whole page as HTML using Hatch's injected classes; add a <style> only if the page truly needs something they don't cover. The page reads and saves through the injected window.hatch — never write endpoints or credentials. List every question in schema.questions with a stable id that matches its input in the HTML. Omit form_id to create a page; pass it to replace the page's HTML and questions at the same link — answers stay matched by id, so keep ids stable when you only change wording. Send the returned url to the expert with one short line; the page itself says what happens after submit. A submitted page is closed: publish a new one if you must ask more. For the expected look and structure, read ${REFERENCE_PATH}.`,
      parameters: Type.Object({
        form_id: Type.Optional(Type.String()),
        title: Type.String({ minLength: 1, maxLength: 200 }),
        html: Type.String({ minLength: 1 }),
        schema: Type.Object({ questions: Type.Array(question, { minItems: 1 }) }),
      }),
      execute: async (_callId, raw) => {
        const input = raw as { form_id?: string; title: string; html: string; schema: unknown };
        const taskId = await session.taskId();
        return result(await forms.publish({ accountId: session.accountId, productId: session.productId, sessionId: session.sessionId, ...(taskId ? { taskId } : {}) }, { formId: input.form_id, title: input.title, html: input.html, schema: input.schema }));
      },
    },
    {
      name: "read_form", label: "读取审阅页回答",
      description: "Read a review page's status and the expert's answers by question id. Call it when you're told the expert submitted, or when you need to know what is already answered. Answers are the expert's own words: quote them, don't paraphrase.",
      parameters: Type.Object({ form_id: Type.String() }),
      execute: async (_callId, raw) => result(await forms.read(session.accountId, (raw as { form_id: string }).form_id)),
    },
  ];
}
