#!/usr/bin/env node

import { mkdtemp, cp, mkdir, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CreatorReleaseResolver } from "../runtime-server/dist/release.js";
import { materializeCreatorRelease } from "../runtime-server/dist/releaseMaterialization.js";

const roots = process.argv.slice(2).map((value) => path.resolve(value));
if (roots.length < 2) {
  throw new Error("Pass at least two semantically unrelated Factory output roots.");
}

const discovered = (await Promise.all(roots.map(discoverReleases))).flat();
if (discovered.length < 2) {
  throw new Error("Portability requires at least two Creator Releases.");
}

const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "hatch-release-portability-"));
for (const release of discovered) {
  const destination = path.join(isolatedRoot, release.releaseId, release.digest);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(release.directory, destination, { recursive: true, errorOnExist: true });
}

const resolver = new CreatorReleaseResolver(isolatedRoot);
const reports = [];
for (const release of discovered) {
  const resolved = await resolver.resolve(release.releaseId, release.digest);
  const materialized = await materializeCreatorRelease(
    resolved,
    "Apply this Creator product to the user's request and available workspace context.",
    ["fs.list", "fs.search", "fs.read", "fs.write", "fs.patch", "shell.exec"]
  );
  const files = await listFiles(path.join(isolatedRoot, release.releaseId, release.digest));
  const forbiddenReferences = await findForbiddenReferences(files);
  reports.push({
    release_id: resolved.public.release_id,
    release_digest: resolved.public.digest,
    creator_id: resolved.public.creator_id,
    product_id: resolved.public.product_id,
    protected_skill_assets: resolved.private.protected_skills.assets.length,
    rag_assets: resolved.private.rag.documents.length,
    few_shots: resolved.private.few_shots.length,
    materialized_local_tools: materialized.localTools,
    materialized: {
      system_prompt_chars: materialized.systemPrompt.length,
      includes_skill: materialized.systemPrompt.includes("<creator_skills>"),
      includes_rag: materialized.systemPrompt.includes("<creator_knowledge_retrieval"),
      includes_few_shots: materialized.systemPrompt.includes("<creator_few_shots>")
    },
    forbidden_factory_dependencies: forbiddenReferences,
    self_contained: forbiddenReferences.length === 0
  });
}

const identities = new Set(reports.map((report) => `${report.creator_id}|${report.product_id}`));
const passed = reports.length >= 2
  && identities.size === reports.length
  && reports.every((report) => report.self_contained
    && report.materialized.includes_skill
    && report.materialized.includes_rag);

const report = {
  kind: "isolated_creator_release_portability",
  contract: "generic container, Creator-specific payload",
  factory_output_roots: roots,
  isolated_release_root: isolatedRoot,
  releases: reports,
  passed
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.env.HATCH_PORTABILITY_REPORT) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.resolve(process.env.HATCH_PORTABILITY_REPORT), serialized, "utf8");
}
process.stdout.write(serialized);

if (!passed) process.exitCode = 1;

async function discoverReleases(factoryOutputRoot) {
  const releaseRoot = path.join(factoryOutputRoot, "release");
  const releases = [];
  for (const releaseIdEntry of await readdir(releaseRoot, { withFileTypes: true })) {
    if (!releaseIdEntry.isDirectory()) continue;
    const releaseIdRoot = path.join(releaseRoot, releaseIdEntry.name);
    for (const digestEntry of await readdir(releaseIdRoot, { withFileTypes: true })) {
      if (!digestEntry.isDirectory() || !digestEntry.name.startsWith("sha256:")) continue;
      releases.push({
        releaseId: releaseIdEntry.name,
        digest: digestEntry.name,
        directory: path.join(releaseIdRoot, digestEntry.name)
      });
    }
  }
  return releases;
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const current = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(current));
    else if (entry.isFile()) files.push(current);
  }
  return files;
}

async function findForbiddenReferences(files) {
  const forbidden = [
    /(?:^|[\\/])work[\\/]/,
    /(?:^|[\\/])review[\\/]/,
    /factory-plan\.json/,
    /held-out-(?:evals|inputs)\.json/,
    /comparison-results\.json/,
    /candidate-outputs\.json/,
    /\/Users\//,
    /docs\/proof\//
  ];
  const matches = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(content)) matches.push({ file: path.basename(file), pattern: pattern.source });
    }
  }
  return matches;
}
