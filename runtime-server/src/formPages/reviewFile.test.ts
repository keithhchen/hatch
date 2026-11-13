import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initialAgentDefinitions, MemoryAgentDefinitionRepository } from "../factoryAgents/definitions.js";
import { WorkbenchStore } from "../factoryAgents/store.js";
import { ACCOUNT, formsHarness, ORIGIN } from "./formKit.js";
import { renderReview, reviewAnswers, writeReview } from "./reviewFile.js";

const PAGE = "<html><head></head><body><script>hatch.save; hatch.submit</script></body></html>";
const schema = { questions: [
  { id: "C01", group: "开场", type: "open", title: "怎么开场", scenario: "他说过「先问预算」", prompt: "你怎么开场？" },
  { id: "C02", type: "choice", title: "语气", prompt: "选一个", options: ["温和", "直接"] },
  { id: "C03", type: "open", title: "没答的", prompt: "还有吗？" },
] };

test("submit hands the review file to the conversation with the answers verbatim and unanswered marked", async () => {
  const h = await formsHarness();
  try {
    const { form_id, url } = await h.forms.publish({ accountId: ACCOUNT, ...ORIGIN }, { title: "审阅：开场 / 语气", html: PAGE, schema });
    const token = h.tokenOf(url);
    await h.forms.save(form_id, token, "C01", "先问预算，\n再问时间。", 0);
    await h.forms.save(form_id, token, "C02", "直接", 0);
    await h.forms.save(form_id, token, "C02__note", "客户喜欢快", 0);
    await h.forms.submit(form_id, token);
    const { review } = h.submitted[0]!;
    assert.match(review.name, /^审阅-开场-语气-[0-9a-f]{8}\.md$/);
    assert.match(review.markdown, /## C01 怎么开场/);
    assert.match(review.markdown, /分组：开场/);
    assert.match(review.markdown, /场景：他说过「先问预算」/);
    assert.match(review.markdown, /问题：你怎么开场？/);
    assert.match(review.markdown, /选项：温和 \/ 直接/);
    assert.match(review.markdown, /> 先问预算，\n> 再问时间。/);
    assert.match(review.markdown, /> 直接/);
    assert.match(review.markdown, /补充说明：\n> 客户喜欢快/);
    assert.match(review.markdown, /## C03 没答的[\s\S]*未回答/);
  } finally { await h.close(); }
});

test("the review file lands in the interview outputs, is overwritten in place, and the build gets it without asking", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-review-file-"));
  try {
    const store = new WorkbenchStore(root, undefined, new MemoryAgentDefinitionRepository(await initialAgentDefinitions()));
    const voice = await store.create("voice");
    const generation = await store.create("generation");
    let changes = 0;
    const page = { id: "11111111-2222-4333-8444-555555555555", title: "审阅", submittedAt: "2026-11-14T00:00:00.000Z" };
    const parsed = schema as never;
    const first = await writeReview(store, voice.id, page.id, renderReview(page, parsed, { C01: "第一版" }), () => changes++);
    assert.match(first, /^output\/review\/审阅-11111111\.md$/);
    assert.equal((await store.get(voice.id)).files.find(file => file.path === first)?.mimeType, "text/markdown");
    // Edited and written again, even under a new title: the same file.
    const second = await writeReview(store, voice.id, page.id, renderReview({ ...page, title: "改名了" }, parsed, { C01: "第二版" }), () => changes++);
    assert.equal(second, first);
    assert.equal(changes, 2);
    assert.equal((await store.get(voice.id)).files.filter(file => file.path.startsWith("output/review/")).length, 1);
    assert.match((await store.read(voice.id, first)).bytes.toString(), /第二版/);
    // The interview and the build are handed it: the text itself, not a path to look up.
    assert.match(await reviewAnswers(store, voice.id), /第二版/);
    const built = await reviewAnswers(store, generation.id);
    assert.match(built, /input\/voice\/review\/审阅-11111111\.md/);
    assert.match(built, /第二版/);
    assert.equal(await reviewAnswers(store, (await store.create("research")).id), "");
  } finally { await rm(root, { recursive: true, force: true }); }
});
