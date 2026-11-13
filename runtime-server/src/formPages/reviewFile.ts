import type { WorkbenchStore } from "../factoryAgents/store.js";
import type { FormPage } from "./repository.js";
import type { FormSchema } from "./schema.js";

/** The Expert's submitted answers as one Markdown file, ready to be written into the interview session's output. */
export type ReviewFile = { name: string; markdown: string };

const REVIEW_DIR = "output/review";
const shortId = (id: string) => id.replace(/-/g, "").slice(0, 8);
const slug = (title: string) => title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 30) || "review";
const quoted = (text: string) => text.trim().split("\n").map(line => `> ${line}`).join("\n");

/** Every question of the page with the Expert's own words under it, verbatim. A question left empty says so. */
export function renderReview(page: Pick<FormPage, "id" | "title" | "submittedAt">, schema: FormSchema, answers: Record<string, unknown>): ReviewFile {
  const out = [`# ${page.title}`, "", `提交时间：${page.submittedAt ?? new Date().toISOString()}`];
  for (const item of schema.questions) {
    const answer = answers[item.id];
    const picked = typeof answer === "string" ? answer : Array.isArray(answer) ? answer.join("、") : "";
    const note = answers[`${item.id}__note`];
    out.push("", `## ${item.id} ${item.title}`, "", ...(item.group ? [`分组：${item.group}`] : []), ...(item.scenario ? [`场景：${item.scenario}`] : []), `问题：${item.prompt}`);
    if (item.options?.length) out.push(`选项：${item.options.join(" / ")}`);
    out.push("", "专家的回答：", picked.trim() ? quoted(picked) : "未回答");
    if (typeof note === "string" && note.trim()) out.push("", "补充说明：", quoted(note));
  }
  return { name: `${slug(page.title)}-${shortId(page.id)}.md`, markdown: `${out.join("\n")}\n` };
}

/** Writes the file into the interview session's outputs. A page keeps one file for good: the same page written again overwrites it, even if its title changed. */
export async function writeReview(store: WorkbenchStore, sessionId: string, formId: string, review: ReviewFile, changed: () => void): Promise<string> {
  const existing = (await store.get(sessionId)).files.find(file => file.path.startsWith(`${REVIEW_DIR}/`) && file.path.endsWith(`-${shortId(formId)}.md`));
  const path = existing?.path ?? `${REVIEW_DIR}/${review.name}`;
  await store.put(sessionId, path, Buffer.from(review.markdown), { actor: "host", mimeType: "text/markdown" });
  changed();
  return path;
}

/** The review files an agent is given without asking: its own, or its voice node's. */
export async function reviewAnswers(store: WorkbenchStore, id: string): Promise<string> {
  const files = (await store.contextFiles(id)).filter(file => /^(output|input\/voice)\/review\/[^/]+\.md$/.test(file.path));
  const texts = await Promise.all(files.map(async file => `## ${file.path}\n\n${(await store.read(id, file.path)).bytes.toString("utf8")}`));
  return texts.join("\n\n");
}
