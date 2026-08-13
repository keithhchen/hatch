import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const DEMO_CREATOR_ID = "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21";
const DEMO_PRODUCT_ID = "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42";
const output = path.resolve(process.argv[2] ?? "/tmp/hatch-demo-agent");
const source = path.join(repo, "fixtures/creator-factory/maya-signal-resume-raw/raw/course");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

async function install(id, relative, sourcePath) {
  const destination = path.join(output, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(sourcePath, destination);
  return { id, path: relative, sha256: await digest(destination) };
}

async function installText(id, relative, value) {
  const destination = path.join(output, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, value.endsWith("\n") ? value : `${value}\n`, "utf8");
  return { id, path: relative, sha256: await digest(destination) };
}

async function digest(file) {
  return `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
}

const system = await installText("system-instructions", "instructions/system.md", `# Signal Resume Review

You are Maya Chen's resume-review Agent. Help the user turn experience into a clear evidence-backed signal map for one target role.

Always separate observed evidence, reasonable inference, and missing proof. Preserve the user's meaning; never invent metrics, employers, responsibilities, or outcomes. Ask for the target role when it is missing. Produce practical revision priorities and example phrasing that the user can verify.

Do not submit applications, impersonate the user, guarantee hiring outcomes, or make protected-class judgments.`);
const skill = await installText("signal-review-skill", "skills/signal-resume-review/SKILL.md", `---
name: signal-resume-review
description: Use when reviewing a resume against a chosen target role.
---

# Signal Resume Review

1. Read the resume and target-role context.
2. Inventory claims as ownership, action, evidence, and outcome.
3. Mark unsupported or ambiguous claims instead of filling gaps.
4. Rank the highest-leverage revisions.
5. Deliver a concise signal map plus verifiable rewrite examples.

Use the method reference for the detailed review model.`);
const method = await install(
  "signal-review-method",
  "skills/signal-resume-review/references/method.md",
  path.join(source, "03-workshop-notes.md")
);
const signalLesson = await install(
  "signal-before-language",
  "knowledge/signal-before-language.md",
  path.join(source, "01-lesson-signal-before-language.md")
);
const evidenceLesson = await install(
  "ownership-and-evidence",
  "knowledge/ownership-and-evidence.md",
  path.join(source, "02-lesson-ownership-and-evidence.md")
);
const synthetic = await installText("synthetic-qa", "evals/synthetic-qa.json", JSON.stringify([{
  id: "missing-target-role",
  input: "Please review my resume.",
  expected: "Ask for the target role before scoring fit."
}], null, 2));
const heldOut = await installText("held-out", "evals/held-out.json", JSON.stringify([{
  id: "no-invented-metrics",
  input: "Rewrite this bullet: Improved onboarding.",
  expected: "Do not invent a percentage; flag the missing outcome evidence."
}], null, 2));

const manifest = {
  contract_version: "1",
  creator: { id: DEMO_CREATOR_ID, name: "Maya Chen" },
  product: {
    id: DEMO_PRODUCT_ID,
    name: "Signal Resume Review",
    description: "An evidence-first resume review for a chosen target role.",
    promise: "Turn resume claims into a clear, defensible signal map and revision plan.",
    boundaries: ["Does not invent evidence or guarantee hiring outcomes.", "Does not submit applications or impersonate the user."],
    offer: { model: "per_delivery", amount_minor: 0, currency: "USD", unit: "review" },
    presentation: { accent: "fern" }
  },
  instructions: { system },
  skills: [{
    id: "signal-resume-review",
    name: "Signal Resume Review",
    when_to_use: "Use when reviewing a resume against a chosen target role.",
    instruction: skill,
    references: [{ asset: method, kind: "method" }],
    allowed_tool_ids: ["hatch.web_search", "hatch.file_search", "hatch.local.files", "hatch.local.shell"]
  }],
  knowledge: { documents: [
    { ...signalLesson, retrieval_only: true, source_summary: "Maya's signal-before-language lesson." },
    { ...evidenceLesson, retrieval_only: true, source_summary: "Maya's ownership-and-evidence lesson." }
  ] },
  tools: [
    { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
    { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" },
    { id: "hatch.local.files", kind: "local_harness", capability: "filesystem" },
    { id: "hatch.local.shell", kind: "local_harness", capability: "shell" }
  ],
  evaluations: { synthetic_qa: [synthetic], held_out: [heldOut] }
};

await writeFile(path.join(output, "agent.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(output);
