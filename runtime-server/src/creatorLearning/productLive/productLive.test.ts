import assert from "node:assert/strict";
import test from "node:test";
import { ReferenceDocument, SkillFolderReader } from "./adapters/workbenchDefinitions.js";
import { AgentDefinition, Corpus, ExpertProduct, InvalidSkills, LiveRelease, SystemMissing } from "./domain.js";
import type { AgentDefinitionRepository, CorpusReleaser, LiveReleaseRepository } from "./ports.js";
import { ProductLiveService } from "./productLiveService.js";

const product = new ExpertProduct("c1", "p1", "主文书点评", "48 小时改到可提交", { questions: [{ id: "q1" }] });
const skill = { id: "essay-review", title: "essay-review", when_to_use: "Review essays", instruction: "Do it", references: [] };
const definition = new AgentDefinition("# SYSTEM", [skill]);

class FixedDefinitions implements AgentDefinitionRepository {
  constructor(private readonly definition: AgentDefinition | null) {}
  async latestFor() { return this.definition; }
}

class FixedLive implements LiveReleaseRepository {
  constructor(private readonly live: LiveRelease | null = null) {}
  async currentFor() { return this.live; }
}

class RecordingReleaser implements CorpusReleaser {
  readonly released: Corpus[] = [];
  async release(_product: ExpertProduct, corpus: Corpus) {
    this.released.push(corpus);
    return { publishedAt: "2026-10-21T00:00:00.000Z", corpusDigest: "sha256:x" };
  }
}

const service = (found: AgentDefinition | null, live?: LiveRelease, releaser = new RecordingReleaser()) =>
  new ProductLiveService(new FixedDefinitions(found), new FixedLive(live), releaser);

test("publishing requires only SYSTEM.md", async () => {
  await assert.rejects(service(null).publish(product), SystemMissing);
  assert.equal(AgentDefinition.whenPresent("  \n", [skill]), null);
});

test("the corpus is System and Skills; Knowledge and Tools stay empty", async () => {
  const releaser = new RecordingReleaser();
  const result = await service(definition, undefined, releaser).publish(product);
  assert.deepEqual(result, { product_id: "p1", status: "published", published_at: "2026-10-21T00:00:00.000Z", corpus_digest: "sha256:x", public_url: "/products/p1" });
  assert.deepEqual(releaser.released[0]!.value, { system_instructions: "# SYSTEM", skills: [skill], knowledge: [], tools: [] });
});

test("status reports publishability, live state and pending changes", async () => {
  assert.deepEqual((await service(null).status(product)).toJSON(), { product_id: "p1", can_publish: false, invalid_skills: [], is_live: false, pending_changes: [], public_url: null, published_at: null });
  const stale = new LiveRelease(Corpus.parse({ system_instructions: "old", skills: [], knowledge: [], tools: [] }), { questions: [] }, "2026-10-01T00:00:00.000Z");
  assert.deepEqual((await service(definition, stale).status(product)).toJSON().pending_changes, ["corpus", "brief"]);
  const current = new LiveRelease(definition.toCorpus(), product.briefSpec, "2026-10-01T00:00:00.000Z");
  assert.deepEqual((await service(definition, current).status(product)).toJSON(), { product_id: "p1", can_publish: true, invalid_skills: [], is_live: true, pending_changes: [], public_url: "/products/p1", published_at: "2026-10-01T00:00:00.000Z" });
});

test("Skills come from output/skills with references and declared kinds", async () => {
  const files: Record<string, string> = {
    "output/skills/essay-review/SKILL.md": "---\nname: essay-review\ndescription: Review college essays\n---\nFollow the method.",
    "output/skills/essay-review/references/opening-lines.md": "---\nkind: example\n---\nOpening examples",
    "output/skills/essay-review/references/rubric.md": "Score each paragraph.",
  };
  const skills = await new SkillFolderReader(Object.keys(files), async (name) => files[name]!).skills();
  assert.equal(skills[0]!.id, "essay-review");
  assert.deepEqual(skills[0]!.references.map(({ id, kind }) => ({ id, kind })), [{ id: "opening-lines", kind: "example" }, { id: "rubric", kind: "method" }]);
  assert.equal(new ReferenceDocument("x", "---\nkind: few_shots\n---\nx").kind, "few_shots");
  assert.equal(new ReferenceDocument("x", "---\nkind: unknown\n---\nx").kind, "method");
});

test("an invalid Skill blocks publishing and is reported instead of crashing status", async () => {
  const files: Record<string, string> = {
    "output/skills/essay-review/SKILL.md": "---\nname: essay-review\ndescription: Review college essays\n---\nFollow the method.",
    "output/skills/Bad_Name/SKILL.md": "---\nname: Bad_Name\ndescription: Broken\n---\nx",
  };
  const { skills, invalid } = await new SkillFolderReader(Object.keys(files), async (name) => files[name]!).load();
  assert.deepEqual(skills.map(({ id }) => id), ["essay-review"]);
  assert.equal(invalid.length, 1);
  assert.match(invalid[0]!, /^Bad_Name: /);
  const broken = new AgentDefinition("# SYSTEM", skills, invalid);
  const view = (await service(broken).status(product)).toJSON();
  assert.equal(view.can_publish, false);
  assert.deepEqual(view.invalid_skills, invalid);
  const releaser = new RecordingReleaser();
  await assert.rejects(service(broken, undefined, releaser).publish(product), InvalidSkills);
  assert.equal(releaser.released.length, 0);
});
