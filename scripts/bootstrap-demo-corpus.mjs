import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const output = path.resolve(process.argv[2] ?? "/tmp/hatch-demo-agent");
const releaseRoot = path.join(repo, "docs/proof/creator-factory-e2e-v1/release/signal-resume-review@1.0.0");
const releaseDigest = (await readdir(releaseRoot, { withFileTypes: true })).find((entry) => entry.isDirectory())?.name;
if (!releaseDigest) throw new Error("Canonical Signal Resume Review release is missing");
const release = path.join(releaseRoot, releaseDigest);
const privateRelease = JSON.parse(await readFile(path.join(release, "private.json"), "utf8"));
const publicRelease = JSON.parse(await readFile(path.join(release, "public.json"), "utf8"));

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

async function install(relative, source) {
  const destination = path.join(output, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination);
  return { id: relative, path: relative, sha256: await digest(destination) };
}

async function installText(relative, text) {
  const destination = path.join(output, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  return { id: relative, path: relative, sha256: await digest(destination) };
}

async function installJson(relative, value) {
  return installText(relative, JSON.stringify(value, null, 2));
}

async function digest(file) {
  return `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
}

const system = await installText("instructions/system.md", privateRelease.system_prompt);
const skill = await install("skills/signal-resume-review/SKILL.md", path.join(release, "skills/signal-resume-review/SKILL.md"));
const method = await install("skills/signal-resume-review/references/method-model.json", path.join(repo, "docs/proof/creator-factory-e2e-v1/work/method/method-model.json"));
const documents = await install("knowledge/documents.json", path.join(release, "rag/documents.json"));
const chunks = await install("knowledge/chunks.json", path.join(release, "rag/chunks.json"));
const synthetic = await installJson("evals/synthetic-qa.json", privateRelease.few_shots);
const heldOut = await install("evals/held-out.json", path.join(repo, "docs/proof/creator-factory-e2e-v1/review/held-out-evals.json"));

const manifest = {
  contract_version: "1",
  agent_id: "signal-resume-review",
  creator: { id: "maya-chen", name: publicRelease.creator.name },
  product: {
    id: publicRelease.product_id,
    name: publicRelease.product.name,
    description: publicRelease.product.description,
  },
  instructions: { system },
  skills: [{
    id: "signal-resume-review",
    name: "Signal Resume Review",
    when_to_use: "Use when reviewing a resume against a chosen target role.",
    instruction: skill,
    references: [{ asset: method, kind: "reference" }],
    allowed_tool_ids: ["hatch.web_search", "hatch.file_search", "hatch.local.files", "hatch.local.shell"],
  }],
  knowledge: { documents: [
    { ...documents, retrieval_only: true, source_summary: "Normalized Creator corpus documents for evidence-grounded resume review." },
    { ...chunks, retrieval_only: true, source_summary: "Normalized Creator corpus chunks with source provenance for retrieval." },
  ] },
  tools: [
    { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
    { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" },
    { id: "hatch.local.files", kind: "local_harness", capability: "filesystem" },
    { id: "hatch.local.shell", kind: "local_harness", capability: "shell" },
  ],
  evaluations: { synthetic_qa: [synthetic], held_out: [heldOut] },
};
await writeFile(path.join(output, "agent.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(output);
