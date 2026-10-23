import assert from "node:assert/strict";
import test from "node:test";
import { ReferenceDocument, SkillFolderReader, runtimeId } from "./adapters/workbenchDefinitions.js";
import { AgentDefinition, Corpus, ExpertProduct, LiveRelease, SystemMissing } from "./domain.js";
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
  assert.deepEqual((await service(null).status(product)).toJSON(), { product_id: "p1", can_publish: false, is_live: false, pending_changes: [], public_url: null, published_at: null });
  const stale = new LiveRelease(Corpus.parse({ system_instructions: "old", skills: [], knowledge: [], tools: [] }), { questions: [] }, "2026-10-01T00:00:00.000Z");
  assert.deepEqual((await service(definition, stale).status(product)).toJSON().pending_changes, ["corpus", "brief"]);
  const current = new LiveRelease(definition.toCorpus(), product.briefSpec, "2026-10-01T00:00:00.000Z");
  assert.deepEqual((await service(definition, current).status(product)).toJSON(), { product_id: "p1", can_publish: true, is_live: true, pending_changes: [], public_url: "/products/p1", published_at: "2026-10-01T00:00:00.000Z" });
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

test("invalid Skill and reference names are repaired; a leftover duplicate yields to the valid Skill", async () => {
  const files: Record<string, string> = {
    "output/skills/creator-product-distillation/SKILL.md": "---\nname: creator-product-distillation\ndescription: Current\n---\nCurrent method.",
    "output/skills/creator_product_distillation/SKILL.md": "---\nname: creator_product_distillation\ndescription: Leftover\n---\nOld method.",
    "output/skills/Essay_Review/SKILL.md": "---\nname: Essay_Review\ndescription: Review essays\n---\nFollow the method.",
    "output/skills/Essay_Review/references/Opening Lines.md": "Opening examples",
    "output/skills/broken/SKILL.md": "no front matter at all",
  };
  const skills = await new SkillFolderReader(Object.keys(files), async (name) => files[name]!).skills();
  assert.deepEqual(skills.map(({ id }) => id), ["creator-product-distillation", "essay-review"]);
  assert.equal(skills[0]!.instruction.trim(), "Current method.");
  assert.deepEqual(skills[1]!.references.map(({ id }) => id), ["opening-lines"]);
  assert.equal(runtimeId("  Foo__Bar--baz "), "foo-bar-baz");
  const releaser = new RecordingReleaser();
  await service(new AgentDefinition("# SYSTEM", skills), undefined, releaser).publish(product);
  assert.equal(releaser.released.length, 1);
});
