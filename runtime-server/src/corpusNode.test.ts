import assert from "node:assert/strict";
import test from "node:test";
import {
  CORPUS_ACTOR_SYSTEM_PROMPT,
  CORPUS_CRITIC_SYSTEM_PROMPT,
  corpusQualityGate,
  type CorpusInput,
  type CorpusOutput
} from "./creatorLearning/corpusNode.js";

const input: CorpusInput = {
  files: ["creator-products/creator-one/product-one/files/file_source/projection.md"],
  about_you: "product-one/about-you/about_you_1/creator-answers.json",
  product: "creator-products/creator-one/product-one/product.json"
};

test("Corpus quality gate rejects card-like candidates before Critic review", async () => {
  const candidate: CorpusOutput = {
    system_instructions: "Decide like the Creator.",
    skills: [{
      id: "position-case",
      title: "Position a case",
      when_to_use: "Use for case positioning.",
      instruction: "Find the strongest point and explain it clearly.",
      references: [{ id: "note", kind: "method", content: "Lead with the strongest proof." }]
    }],
    knowledge: [],
    tools: []
  };

  const feedback = await corpusQualityGate({ input, round: 1, candidate, candidateRef: "product-one/corpus/run/candidate-1.json" });

  assert.match(feedback ?? "", /too short/);
  assert.match(feedback ?? "", /thin Skill instructions/);
  assert.match(feedback ?? "", /thin references/);
  assert.match(feedback ?? "", /operational playbook/);
});

test("Corpus quality gate accepts a dense operational candidate", async () => {
  const candidate = denseCorpus();

  assert.equal(await corpusQualityGate({ input, round: 1, candidate, candidateRef: "product-one/corpus/run/candidate-1.json" }), undefined);
});

test("Corpus quality gate scales the behavior floor with source volume", async () => {
  const feedback = await corpusQualityGate({
    input,
    round: 1,
    candidate: denseCorpus(),
    candidateRef: "product-one/corpus/run/candidate-1.json",
    readInputObject: async (reference) => ({
      path: reference,
      content: paragraph("source", 40000),
      bytes: Buffer.byteLength(paragraph("source", 40000), "utf8")
    })
  });

  assert.match(feedback ?? "", /Declared source material has 40000 chars/);
  assert.match(feedback ?? "", /expected at least 10000/);
});

test("Corpus prompts require operational density, not summary cards", () => {
  assert.match(CORPUS_ACTOR_SYSTEM_PROMPT, /operating manual/);
  assert.match(CORPUS_ACTOR_SYSTEM_PROMPT, /Do not create one-sentence Skills/);
  assert.match(CORPUS_CRITIC_SYSTEM_PROMPT, /Operational density/);
  assert.match(CORPUS_CRITIC_SYSTEM_PROMPT, /short labels, slogans, summaries, or reminders/);
});

function denseCorpus(): CorpusOutput {
  return {
    system_instructions: paragraph("system", 1300),
    skills: Array.from({ length: 6 }, (_, index) => ({
      id: `skill-${index + 1}`,
      title: `Skill ${index + 1}`,
      when_to_use: paragraph(`when ${index + 1}`, 140),
      instruction: paragraph(`instruction ${index + 1}`, 700),
      references: [
        { id: `method-${index + 1}`, kind: "method" as const, content: paragraph(`method ${index + 1}`, 180) },
        { id: `example-${index + 1}`, kind: "example" as const, content: paragraph(`example ${index + 1}`, 180) }
      ]
    })),
    knowledge: [{ source: input.files[0]!, title: "Source file" }],
    tools: []
  };
}

function paragraph(seed: string, minimumChars: number): string {
  const sentence = `${seed} keeps trigger, intake, decision criteria, output shape, quality bar, exception handling, and refusal boundaries explicit. `;
  return sentence.repeat(Math.ceil(minimumChars / sentence.length)).slice(0, minimumChars);
}
