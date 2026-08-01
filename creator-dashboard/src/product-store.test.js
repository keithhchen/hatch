import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildProductCatalog, writeProductCatalogSnapshot } from "./catalog-import.js";
import { CreatorProductStore } from "./product-store.js";

const root = path.resolve(import.meta.dirname, "../..");
const connectedProofRoot = path.join(root, "docs/proof/creator-factory-e2e-v1");
const proofRoot = connectedProofRoot;
const portabilityProofRoot = path.join(connectedProofRoot, "work/portability-proof");
const releaseId = "signal-resume-review@1.0.0";
const releaseDigest = "sha256:d806cf915b29fa952e43ab4aaf02431cc39dfdde6a29b0d20509a07562eaaec5";

async function openStore(directory, evidence = {}) {
  const factoryOutput = path.join(directory, "factory-output");
  await cp(proofRoot, factoryOutput, { recursive: true });
  const runtimeResultsPath = path.join(factoryOutput, "review/runtime-results.json");
  const comparisonResultsPath = path.join(factoryOutput, "review/comparison-results.json");
  await Promise.all([
    rm(runtimeResultsPath, { force: true }),
    rm(comparisonResultsPath, { force: true })
  ]);
  if (evidence.runtime) await writeFile(runtimeResultsPath, JSON.stringify(evidence.runtime));
  if (evidence.comparison) await writeFile(comparisonResultsPath, JSON.stringify(evidence.comparison));
  const catalogPath = path.join(directory, "product-catalog.json");
  await writeProductCatalogSnapshot([factoryOutput], catalogPath);
  return CreatorProductStore.open({
    catalogPath,
    statePath: path.join(directory, "state.json")
  });
}

test("Factory gates alone never masquerade as a publish-ready product", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-product-store-"));
  const store = await openStore(directory);
  const [product] = store.listForCreator("maya-chen");

  assert.equal(product.status, "preparing");
  assert.equal(product.publication.status, "preparing");
  assert.equal(store.getPublishRequest("maya-chen", product.product_id), null);
  assert.equal(store.listForCreator("another-creator").length, 0);
});

test("matching runtime and a passing blind comparison unlock only the exact Factory Release", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-product-store-"));
  const matching = { release_id: releaseId, release_digest: releaseDigest, passed: true };
  const comparison = {
    ...matching,
    gate: { passed: true },
    summary: { creator_agent: { pass_rate: 0.9 }, generic_baseline: { pass_rate: 0.5 }, delta: 0.4 }
  };
  const store = await openStore(directory, { runtime: matching, comparison });
  const [product] = store.listForCreator("maya-chen");

  assert.equal(product.status, "ready_to_publish");
  assert.deepEqual(store.getPublishRequest("maya-chen", product.product_id), {
    release_id: releaseId,
    release_digest: releaseDigest
  });

  await store.markPublished({
    creator_id: "maya-chen",
    product_id: "signal-resume-review",
    release_id: releaseId,
    release_digest: releaseDigest,
    published_at: "2026-07-31T10:00:00Z"
  });
  assert.equal(store.listForCreator("maya-chen")[0].status, "published");
  const reopened = await CreatorProductStore.open({
    catalogPath: path.join(directory, "product-catalog.json"),
    statePath: path.join(directory, "state.json")
  });
  assert.equal(reopened.listForCreator("maya-chen")[0].status, "published");
});

test("a new exact Release never inherits the previous digest's published state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-product-version-"));
  const matching = { release_id: releaseId, release_digest: releaseDigest, passed: true };
  const comparison = {
    ...matching,
    gate: { passed: true },
    summary: { creator_agent: { pass_rate: 0.9 }, generic_baseline: { pass_rate: 0.5 }, delta: 0.4 }
  };
  const store = await openStore(directory, { runtime: matching, comparison });
  await store.markPublished({
    creator_id: "maya-chen",
    product_id: "signal-resume-review",
    release_id: releaseId,
    release_digest: releaseDigest,
    published_at: "2026-07-31T10:00:00Z"
  });

  const catalogPath = path.join(directory, "product-catalog.json");
  const nextDigest = `sha256:${"a".repeat(64)}`;
  const nextReleaseId = "signal-resume-review@1.0.1";
  const nextCatalog = JSON.parse(await readFile(catalogPath, "utf8"));
  nextCatalog.products[0] = {
    ...nextCatalog.products[0],
    version: "1.0.1",
    release_id: nextReleaseId,
    release_digest: nextDigest,
    publication: { status: "preparing", summary: "Hatch is preparing this version for publication." }
  };
  await writeFile(catalogPath, `${JSON.stringify(nextCatalog, null, 2)}\n`, "utf8");

  const reopened = await CreatorProductStore.open({
    catalogPath,
    statePath: path.join(directory, "state.json")
  });
  const [nextProduct] = reopened.listForCreator("maya-chen");

  assert.equal(nextProduct.status, "preparing");
  assert.equal(nextProduct.published_at, null);
  assert.equal(nextProduct.release_id, nextReleaseId);
  assert.equal(nextProduct.release_digest, nextDigest);
  assert.equal(reopened.getPublishRequest("maya-chen", "signal-resume-review"), null);
});

test("a completed baseline file or zero-delta comparison cannot unlock publishing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-product-store-"));
  const matching = { release_id: releaseId, release_digest: releaseDigest, passed: true };
  const store = await openStore(directory, {
    runtime: matching,
    comparison: {
      ...matching,
      gate: { passed: true },
      summary: { creator_agent: { pass_rate: 0.9 }, generic_baseline: { pass_rate: 0.9 }, delta: 0 }
    }
  });
  const [product] = store.listForCreator("maya-chen");
  assert.equal(product.status, "preparing");
  assert.equal(store.getPublishRequest("maya-chen", product.product_id), null);
});

test("Creator catalog exposes the publishable offer, not Factory evals or Human-in-the-loop review", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-product-review-"));
  const catalogPath = path.join(directory, "product-catalog.json");
  await writeProductCatalogSnapshot([connectedProofRoot], catalogPath);
  const store = await CreatorProductStore.open({
    catalogPath,
    statePath: path.join(directory, "state.json")
  });
  const [product] = store.listForCreator("maya-chen");
  assert.equal(product.status, "ready_to_publish");
  assert.equal(product.publication.status, "ready");
  assert.equal(JSON.stringify(product).includes("representative_cases"), false);
  assert.equal(JSON.stringify(product).includes("expected_answer"), false);
  assert.equal(JSON.stringify(product).includes("factory-input"), false);
});

test("catalog import contains only Dashboard-owned product and publication fields", async () => {
  const catalog = await buildProductCatalog([connectedProofRoot]);
  const serialized = JSON.stringify(catalog);

  assert.equal(serialized.includes("factory-input"), false);
  assert.equal(serialized.includes("/work/"), false);
  assert.equal(serialized.includes("/review/"), false);
  assert.equal(serialized.includes("source_path"), false);
  assert.equal(serialized.includes("trace_closure"), false);
  assert.equal(serialized.includes("expected_answer"), false);
  assert.equal(catalog.products[0].publication.status, "ready");
  assert.equal(serialized.includes("representative_cases"), false);
});

test("an unrelated Creator Release appears in the same Dashboard product model without code changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-product-portability-"));
  const catalogPath = path.join(directory, "product-catalog.json");
  await writeProductCatalogSnapshot([connectedProofRoot, portabilityProofRoot], catalogPath);
  const store = await CreatorProductStore.open({
    catalogPath,
    statePath: path.join(directory, "state.json")
  });
  const [ariProduct] = store.listForCreator("ari-cole");

  assert.equal(ariProduct.product_id, "ari-seven-day-strength-plan");
  assert.equal(ariProduct.name, "Ari Seven-Day Strength Plan");
  assert.equal(ariProduct.status, "preparing");
  assert.equal(store.listForCreator("maya-chen").length, 1);
});
