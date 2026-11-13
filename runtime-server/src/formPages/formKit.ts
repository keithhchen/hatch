import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalArtifactObjectStore } from "../creatorLearning/objectStore.js";
import { FormLinks } from "./links.js";
import type { FormPage, FormRepository } from "./repository.js";
import { MemoryFormRepository } from "./repository.js";
import { FormClosed, FormConflict, parseFormSchema } from "./schema.js";
import { FormPages } from "./service.js";

export const ACCOUNT = "11111111-1111-4111-8111-111111111111";
export const OTHER = "22222222-2222-4222-8222-222222222222";
export const ORIGIN = { productId: "p1", sessionId: "s1" };
export const schema = (...ids: string[]) => ({ questions: ids.map(id => ({ id, type: "open", title: id, prompt: `问题 ${id}` })) });

export async function formsHarness(repository: FormRepository = new MemoryFormRepository()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-forms-"));
  const submitted: Array<Pick<FormPage, "id" | "title" | "origin">> = [];
  let failNotice = false;
  const links = new FormLinks("test-secret", "https://hatch.test");
  const forms = new FormPages({ repository, store: new LocalArtifactObjectStore(root), links, submissions: { submitted: async page => { if (failNotice) throw new Error("down"); submitted.push(page); } } });
  const tokenOf = (url: string) => new URL(url).searchParams.get("t");
  return { forms, links, submitted, tokenOf, failNotice: (value: boolean) => { failNotice = value; }, close: () => rm(root, { recursive: true, force: true }) };
}

/** Behaviour every repository keeps: run against Memory here and Postgres in formPages.postgres.test.ts. */
export function formConformance(name: string, open: () => Promise<{ repository: FormRepository; close: () => Promise<void> }>) {
  test(`${name}: answers save by version, clear, conflict, and a submit closes the page`, async () => {
    const { repository, close } = await open();
    try {
      await repository.create({ id: "form_a", accountId: ACCOUNT, title: "t", htmlKey: "k/1", schema: parseFormSchema(schema("C01")), origin: ORIGIN });
      const first = await repository.save("form_a", "C01", "一", 0);
      assert.equal(first.version, 1);
      await assert.rejects(() => repository.save("form_a", "C01", "二", 0), FormConflict, "a page that never saw the first answer is stale");
      assert.equal((await repository.save("form_a", "C01", "二", 1)).version, 2);
      const cleared = await repository.save("form_a", "C01", null, 2);
      assert.deepEqual([cleared.value, cleared.version], [null, 3], "a cleared answer keeps counting");
      await assert.rejects(() => repository.save("form_a", "C01", "三", 0), FormConflict);
      const { first: closedNow } = await repository.submit("form_a");
      assert.equal(closedNow, true);
      assert.equal((await repository.submit("form_a")).first, false, "only one submit closes it");
      await assert.rejects(() => repository.save("form_a", "C01", "四", 3), FormClosed);
      await assert.rejects(() => repository.revise("form_a", 1, { title: "t", htmlKey: "k/2", schema: parseFormSchema(schema("C01")), origin: ORIGIN }), FormClosed);
      assert.equal((await repository.get("form_a"))?.status, "submitted");
      assert.equal((await repository.answers("form_a")).length, 1);
    } finally { await close(); }
  });

  test(`${name}: a revision is applied once to the version it was made from`, async () => {
    const { repository, close } = await open();
    try {
      await repository.create({ id: "form_b", accountId: ACCOUNT, title: "t", htmlKey: "k/1", schema: parseFormSchema(schema("C01")), origin: ORIGIN });
      const revised = await repository.revise("form_b", 1, { title: "t2", htmlKey: "k/2", schema: parseFormSchema(schema("C01", "C02")), origin: ORIGIN });
      assert.deepEqual([revised?.version, revised?.title], [2, "t2"]);
      assert.equal(await repository.revise("form_b", 1, { title: "t3", htmlKey: "k/3", schema: parseFormSchema(schema("C01")), origin: ORIGIN }), undefined);
    } finally { await close(); }
  });
}

