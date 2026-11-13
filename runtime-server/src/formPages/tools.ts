import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { result } from "../factoryAgents/files.js";
import type { FormPages } from "./service.js";

export const FORM_TOOLS = ["publish_form", "read_form", "form_reference"];
const REFERENCE = new URL("../../prompts/factory-agents/voice/form-reference/", import.meta.url);

const question = Type.Object({
  id: Type.String({ description: "Stable id such as C01. Never renumber when editing; answers are matched by it." }),
  group: Type.Optional(Type.String()),
  type: Type.Union([Type.Literal("open"), Type.Literal("choice"), Type.Literal("multi")]),
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
      description: "Publish a full HTML review page for the Expert and get its link (the Expert opens it on a phone, often from Telegram or WhatsApp). Call form_reference first: it returns the reference page and the Hatch base CSS that is already injected into every page. In the page, use only the injected client `window.hatch = { schema, answers, status, save(id, value), clear(id), submit() }` (save/clear/submit return Promises); never write an endpoint or credential. `schema` is the question tree and must match the page ids one to one. Omit form_id for a new page; pass form_id to edit the same page: same link, answers kept by question id, never renumber. A submitted page cannot be edited. Send the returned url to the Expert.",
      parameters: Type.Object({
        form_id: Type.Optional(Type.String()),
        title: Type.String({ minLength: 1, maxLength: 200 }),
        html: Type.String({ minLength: 1, description: "One self-contained HTML page. Default: no <style>; use the base classes." }),
        schema: Type.Object({ questions: Type.Array(question, { minItems: 1 }) }),
      }),
      execute: async (_callId, raw) => {
        const input = raw as { form_id?: string; title: string; html: string; schema: unknown };
        return result(await forms.publish({ accountId: session.accountId, productId: session.productId, sessionId: session.sessionId, ...(await session.taskId() ? { taskId: await session.taskId() } : {}) }, { formId: input.form_id, title: input.title, html: input.html, schema: input.schema }));
      },
    },
    {
      name: "read_form", label: "读取审阅页回答",
      description: "Read what the Expert has answered on a review page: status (open or submitted) and answers by question id (a choice's side note is `<id>__note`). Call it when the submit notification arrives.",
      parameters: Type.Object({ form_id: Type.String() }),
      execute: async (_callId, raw) => result(await forms.read(session.accountId, (raw as { form_id: string }).form_id)),
    },
    {
      name: "form_reference", label: "审阅页参考",
      description: "The reference review page (index.html, app.js) and the Hatch base CSS (base.css) already injected into every form page. Read it before drafting your first page, and follow its structure and class names.",
      parameters: Type.Object({}),
      execute: async () => result(Object.fromEntries(await Promise.all(["index.html", "app.js", "base.css"].map(async name => [name, await readFile(fileURLToPath(new URL(name, REFERENCE)), "utf8")])))),
    },
  ];
}
