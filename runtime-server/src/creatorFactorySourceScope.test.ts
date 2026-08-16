import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { loadInputManifest } from "./creatorFactoryCli.js";
import { parseRawSourcesFromPacket } from "./creatorLearning/corpusReleaseGuards.js";
import { CreatorFactory } from "./creatorLearning/engine.js";
import { FactoryFileStore } from "./creatorLearning/fileStore.js";
import {
  resolveCreatorSourceScope,
  type CreatorSourceScopeInput
} from "./creatorLearning/sourceScope.js";

const CREATOR_DIRECTORY = "creators/madeline-mann";

test("source_scope ingests a complete Madeline-shaped directory: 15/15 regular files", async (t) => {
  const files: Record<string, string> = {
    "creator.json": "{\"id\":\"madeline-mann\"}\n",
    "articles/about.md": "About\n",
    "articles/fill-in-the-blank-job-hunt.md": "Fill in the blank\n",
    "articles/free-resources.md": "Free resources\n",
    "articles/home.md": "Home\n",
    "articles/job-interview-secrets.md": "Interview secrets\n",
    "youtube/-QXAG3AT1p0.md": "Transcript 1\n",
    "youtube/1ey58zDpBgE.md": "Transcript 2\n",
    "youtube/IV30jAw7dxA.md": "Transcript 3\n",
    "youtube/MC9pzXp3168.md": "Transcript 4\n",
    "youtube/ZSSID5mp93o.md": "Transcript 5\n",
    "youtube/fYHR0KgnGHU.md": "Transcript 6\n",
    "youtube/ffDWJOmPQIQ.md": "Transcript 7\n",
    "youtube/mDr1j6LnSqo.md": "Transcript 8\n",
    "youtube/xj-8YmjkOuk.md": "Transcript 9\n"
  };
  const fixture = await sourcePackFixture(t, files);
  const resolved = await resolveCreatorSourceScope(fixture.scope, fixture.manifestDirectory);

  assert.equal(resolved.sources.length, 15);
  assert.equal(resolved.sourceManifest.file_count, 15);
  assert.equal(resolved.sourceManifest.files.length, 15);
  assert.equal(new Set(resolved.sourceManifest.files.map((file) => file.path)).size, 15);
  assert.equal(new Set(resolved.sourceManifest.files.map((file) => file.source_id)).size, 15);
  assert.equal(resolved.sourceManifest.files.some((file) => file.path.endsWith("/creator.json")), true);
  assert.equal(resolved.sourceManifest.files.filter((file) => file.path.includes("/articles/")).length, 5);
  assert.equal(resolved.sourceManifest.files.filter((file) => file.path.includes("/youtube/")).length, 9);
  assert.deepEqual(resolved.sourceManifest.integrity, { kind: "directory_snapshot" });
  assert.deepEqual(
    resolved.sourceManifest.files.map((file) => file.title),
    resolved.sources.map((source) => source.title)
  );
  assert.match(resolved.sourceManifest.root_digest, /^sha256:[a-f0-9]{64}$/);

  const secondFixture = await sourcePackFixture(t, files);
  const sameFilesAtAnotherAbsoluteRoot = await resolveCreatorSourceScope(
    secondFixture.scope,
    secondFixture.manifestDirectory
  );
  assert.equal(
    sameFilesAtAnotherAbsoluteRoot.sourceManifest.root_digest,
    resolved.sourceManifest.root_digest,
    "host absolute pack_root must not affect the delivered-set digest"
  );
});

const repositoryRoot = [
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  path.resolve(process.cwd(), ".."),
  process.cwd()
].find((candidate) => existsSync(path.join(candidate, ".hatch-local/creator-factory/source-packs")))
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const localOperatorDirectory = path.join(
  repositoryRoot,
  ".hatch-local/creator-factory/operator-e2e-2026-08-12/madeline-mann"
);
const localPackRoot = path.join(
  repositoryRoot,
  ".hatch-local/creator-factory/source-packs/na-jp-creator-reference-seed-2026-08-12"
);

test("local Madeline operator pack, when present, resolves every real file 15/15", {
  skip: !existsSync(localPackRoot)
}, async () => {
  const resolved = await resolveCreatorSourceScope({
    pack_root: "../../source-packs/na-jp-creator-reference-seed-2026-08-12",
    creator_directory: CREATOR_DIRECTORY
  }, localOperatorDirectory);

  assert.equal(resolved.sources.length, 15);
  assert.equal(resolved.sourceManifest.file_count, 15);
  assert.equal(resolved.sourceManifest.files.filter((file) => file.path.endsWith("/creator.json")).length, 1);

  await assert.rejects(
    () => resolveCreatorSourceScope({
      pack_root: "../../source-packs/na-jp-creator-reference-seed-2026-08-12",
      creator_directory: CREATOR_DIRECTORY,
      completeness: "all_regular_files",
      manifest: {
        path: "source-pack.json",
        digest: "sha256:44f4bf4ea26b5a0d7815d879fa938975750dde132933002cb672838ee9d8075d"
      }
    }, localOperatorDirectory),
    /extra files: .*creator\.json/,
    "source-pack.json omits creator.json and therefore must fail closed as the ground truth"
  );
});

test("source_scope rejects missing and extra files instead of silently selecting a subset", async (t) => {
  const missingFixture = await sourcePackFixture(t, { "kept.md": "kept\n" }, [
    checksumRow(`${CREATOR_DIRECTORY}/kept.md`, Buffer.from("kept\n")),
    checksumRow(`${CREATOR_DIRECTORY}/missing.md`, Buffer.from("missing\n"))
  ]);
  await assert.rejects(
    () => resolveCreatorSourceScope(missingFixture.checksummedScope, missingFixture.manifestDirectory),
    /missing files: .*missing\.md/
  );

  const extraFixture = await sourcePackFixture(t, {
    "kept.md": "kept\n",
    "extra.md": "extra\n"
  }, [checksumRow(`${CREATOR_DIRECTORY}/kept.md`, Buffer.from("kept\n"))]);
  await assert.rejects(
    () => resolveCreatorSourceScope(extraFixture.checksummedScope, extraFixture.manifestDirectory),
    /extra files: .*extra\.md/
  );
});

test("source_scope rejects duplicate checksum declarations and hash mismatch", async (t) => {
  const duplicateRow = checksumRow(`${CREATOR_DIRECTORY}/one.md`, Buffer.from("one\n"));
  const duplicateFixture = await sourcePackFixture(t, { "one.md": "one\n" }, [duplicateRow, duplicateRow]);
  await assert.rejects(
    () => resolveCreatorSourceScope(duplicateFixture.checksummedScope, duplicateFixture.manifestDirectory),
    /duplicate path: .*one\.md/
  );

  const hashFixture = await sourcePackFixture(t, { "one.md": "actual\n" }, [
    checksumRow(`${CREATOR_DIRECTORY}/one.md`, Buffer.from("different\n"))
  ]);
  await assert.rejects(
    () => resolveCreatorSourceScope(hashFixture.checksummedScope, hashFixture.manifestDirectory),
    /hash mismatch for .*one\.md/
  );
});

test("source_scope can bind a digest-locked JSON file manifest", async (t) => {
  const files = {
    "one.md": "one\n",
    "nested/two.md": "two\n"
  };
  const fixture = await sourcePackFixture(t, files);
  const inventory = `${JSON.stringify({
    files: Object.entries(files).map(([relativePath, content]) => ({
      path: `${CREATOR_DIRECTORY}/${relativePath}`,
      bytes: Buffer.byteLength(content),
      sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`
    }))
  }, null, 2)}\n`;
  await writeFile(path.join(fixture.packRoot, "inventory.json"), inventory, "utf8");
  const digest = `sha256:${createHash("sha256").update(inventory).digest("hex")}`;
  const scope: CreatorSourceScopeInput = {
    pack_root: fixture.packRoot,
    creator_directory: CREATOR_DIRECTORY,
    completeness: "all_regular_files",
    manifest: { path: "inventory.json", digest }
  };

  const resolved = await resolveCreatorSourceScope(scope, fixture.manifestDirectory);
  assert.equal(resolved.sourceManifest.file_count, 2);
  assert.deepEqual(resolved.sourceManifest.integrity, { kind: "manifest", path: "inventory.json", sha256: digest });
  await assert.rejects(
    () => resolveCreatorSourceScope({
      ...scope,
      manifest: { path: "inventory.json", digest: `sha256:${"0".repeat(64)}` }
    }, fixture.manifestDirectory),
    /manifest digest mismatch/
  );
});

test("source_scope rejects ambiguous or malformed optional JSON inventories", async (t) => {
  const fixture = await sourcePackFixture(t, { "one.md": "one\n" });
  const entry = {
    path: `${CREATOR_DIRECTORY}/one.md`,
    bytes: 4,
    sha256: `sha256:${createHash("sha256").update("one\n").digest("hex")}`
  };
  const attempt = async (inventory: unknown): Promise<void> => {
    const text = `${JSON.stringify(inventory)}\n`;
    await writeFile(path.join(fixture.packRoot, "inventory.json"), text, "utf8");
    await resolveCreatorSourceScope({
      pack_root: fixture.packRoot,
      creator_directory: CREATOR_DIRECTORY,
      manifest: {
        path: "inventory.json",
        digest: `sha256:${createHash("sha256").update(text).digest("hex")}`
      }
    }, fixture.manifestDirectory);
  };

  await assert.rejects(() => attempt({ files: [entry], documents: [entry] }), /exactly one/);
  await assert.rejects(() => attempt({ files: {} }), /files must be an array/);
});

test("source_scope preserves empty files and UTF-8 BOM bytes without filtering", async (t) => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("text\n", "utf8")]);
  const fixture = await sourcePackFixture(t, {
    "empty.md": Buffer.alloc(0),
    "bom.md": bom
  });
  const resolved = await resolveCreatorSourceScope(fixture.scope, fixture.manifestDirectory);

  assert.equal(resolved.sourceManifest.file_count, 2);
  assert.equal(resolved.sources.find((source) => source.title === "empty.md")?.content, "");
  assert.equal(resolved.sources.find((source) => source.title === "bom.md")?.content.charCodeAt(0), 0xfeff);
  assert.equal(resolved.sourceManifest.files.find((file) => file.title === "bom.md")?.bytes, bom.byteLength);
});

test("source_scope rejects symlinks, path escape, and invalid UTF-8", async (t) => {
  const symlinkFixture = await sourcePackFixture(t, { "regular.md": "regular\n" });
  const outside = path.join(symlinkFixture.packRoot, "outside.md");
  await writeFile(outside, "outside\n", "utf8");
  await symlink(outside, path.join(symlinkFixture.creatorRoot, "linked.md"));
  await assert.rejects(
    () => resolveCreatorSourceScope(symlinkFixture.scope, symlinkFixture.manifestDirectory),
    /rejects symbolic link: .*linked\.md/
  );

  await assert.rejects(
    () => resolveCreatorSourceScope({
      ...symlinkFixture.scope,
      creator_directory: "../outside"
    }, symlinkFixture.manifestDirectory),
    /must not escape pack_root/
  );

  const invalidBytes = Buffer.from([0xc3, 0x28]);
  const utf8Fixture = await sourcePackFixture(t, { "invalid.md": invalidBytes });
  await assert.rejects(
    () => resolveCreatorSourceScope(utf8Fixture.scope, utf8Fixture.manifestDirectory),
    /invalid\.md contains invalid UTF-8/
  );
});

test("source_scope and manually listed sources are mutually exclusive", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-source-scope-cli-xor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, "factory-input.json");
  await writeFile(manifestPath, `${JSON.stringify({
    creator: { id: "creator", name: "Creator" },
    productName: "Product",
    productPromise: "Brief",
    sources: [{ id: "S1", authority: "public_context", title: "One", content: "One" }],
    source_scope: {
      pack_root: ".",
      creator_directory: "creator"
    }
  }, null, 2)}\n`, "utf8");

  await assert.rejects(() => loadInputManifest(manifestPath), /mutually exclusive/);
});

test("Factory persists the frozen source manifest and rejects post-verification tampering", async (t) => {
  const fixture = await sourcePackFixture(t, {
    " leading.md": "first\r\nsecond\rbare\u2028separator\u2029end\r\n",
    "trailing.md ": "two\n",
    "\uFEFFname.md": "three\n"
  });
  const resolved = await resolveCreatorSourceScope(fixture.scope, fixture.manifestDirectory);
  const runsRoot = path.join(fixture.packRoot, "runs");
  const factory = new CreatorFactory(
    runsRoot,
    async (call) => {
      if (call.purpose === "evidence.extract") return "# Evidence\n\nEvery frozen source reached evidence.\n";
      if (call.purpose === "eval.generate_questions") {
        return [
          "## Q1\n### Question\nCase one?\n### Why this question\nTradeoff.\n### Leakage group\ng1",
          "## Q2\n### Question\nCase two?\n### Why this question\nBoundary.\n### Leakage group\ng2"
        ].join("\n\n");
      }
      throw new Error(`unexpected Factory call: ${call.purpose}`);
    },
    async () => "unused"
  );
  const input = {
    runId: "source-manifest-persistence",
    creator: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Madeline Mann" },
    productName: "Interview answer",
    productPromise: "Return one grounded interview answer.",
    ...resolved,
    config: { developmentQuestions: 1, heldoutQuestions: 1, maxCorpusRevisions: 1 }
  };
  const expectedSources = structuredClone(resolved.sources);
  const originalFirstSource = input.sources[0]!.content;
  const raceSentinel = "MUTATED_DURING_FIRST_BEFORE_COMMIT";
  let mutationInjected = false;
  const state = await factory.start(input, {
    beforeCommit: async () => {
      if (mutationInjected) return;
      mutationInjected = true;
      input.sources[0]!.content += raceSentinel;
    }
  });
  assert.equal(state.stage, "awaiting_creator_answers");
  assert.equal(input.sources[0]!.content.includes(raceSentinel), true, "the test must exercise caller mutation");
  assert.ok(state.artifacts.sourceManifest);
  const store = new FactoryFileStore(runsRoot, state.runId);
  const persistedText = await store.readArtifact(state.artifacts.sourceManifest!);
  const persisted = JSON.parse(persistedText);
  assert.deepEqual(persisted, resolved.sourceManifest);
  assert.equal(persistedText.includes(fixture.packRoot), false);
  assert.notEqual(state.artifacts.sourceManifest!.sha256, resolved.sourceManifest.root_digest);
  const sourcePacket = await store.readArtifact(state.artifacts.sourcePacket);
  assert.equal(sourcePacket.includes(raceSentinel), false);
  assert.deepEqual(parseRawSourcesFromPacket(sourcePacket), expectedSources);

  const tampered = structuredClone(input);
  tampered.runId = "source-manifest-tampered";
  tampered.sources[0]!.content = `${originalFirstSource}tampered`;
  await assert.rejects(() => factory.start(tampered), /content hash\/bytes mismatch/);

  const manifestPath = path.join(
    store.directory,
    ...state.artifacts.sourceManifest!.path.split("/")
  );
  await writeFile(manifestPath, "{}\n", "utf8");
  const failedClosed = await factory.resume(state.runId);
  assert.equal(failedClosed.stage, "needs_attention");
  assert.match(failedClosed.lastError ?? "", /Artifact digest mismatch/);

  await writeFile(manifestPath, persistedText, "utf8");
  await factory.status(state.runId);
  await rm(manifestPath);
  await assert.rejects(() => factory.status(state.runId), /ENOENT/);
});

async function sourcePackFixture(
  t: TestContext,
  files: Record<string, string | Buffer>,
  checksumRows?: string[]
): Promise<{
  packRoot: string;
  creatorRoot: string;
  manifestDirectory: string;
  scope: CreatorSourceScopeInput;
  checksummedScope: CreatorSourceScopeInput;
}> {
  const packRoot = await mkdtemp(path.join(os.tmpdir(), "hatch-source-scope-pack-"));
  t.after(() => rm(packRoot, { recursive: true, force: true }));
  const creatorRoot = path.join(packRoot, ...CREATOR_DIRECTORY.split("/"));
  await mkdir(creatorRoot, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const destination = path.join(creatorRoot, ...relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  const rows = checksumRows ?? Object.entries(files)
    .map(([relativePath, content]) => checksumRow(
      `${CREATOR_DIRECTORY}/${relativePath}`,
      typeof content === "string" ? Buffer.from(content, "utf8") : content
    ));
  await writeFile(path.join(packRoot, "checksums.sha256"), `${rows.join("\n")}\n`, "utf8");
  return {
    packRoot,
    creatorRoot,
    manifestDirectory: packRoot,
    scope: {
      pack_root: packRoot,
      creator_directory: CREATOR_DIRECTORY
    },
    checksummedScope: {
      pack_root: packRoot,
      creator_directory: CREATOR_DIRECTORY,
      checksums_sha256: { path: "checksums.sha256" }
    }
  };
}

function checksumRow(relativePath: string, content: Buffer): string {
  return `${createHash("sha256").update(content).digest("hex")}  ${relativePath}`;
}
