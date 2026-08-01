import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const FACTORY_PATHS = Object.freeze({
  releaseDirectory: "release",
  runtimeResults: ["review/runtime-results-scenario.json", "review/runtime-results.json"],
  comparisonResults: ["review/runtime-blind-comparison.json", "review/comparison-results.json"],
  gates: "work/reports/gates.json",
  verification: "work/reports/release-verification.json"
});

export async function buildProductCatalog(factoryOutputRoots) {
  if (!Array.isArray(factoryOutputRoots) || factoryOutputRoots.length === 0) {
    throw new Error("At least one completed Factory output root is required.");
  }
  const products = (await Promise.all(factoryOutputRoots.map(loadFactoryOutput))).flat();
  assertUniqueReleaseIdentities(products);
  return {
    schema_version: "1",
    products: products.sort((left, right) => (
      left.creator_id.localeCompare(right.creator_id)
      || left.product_id.localeCompare(right.product_id)
      || compareVersions(left.version, right.version)
    ))
  };
}

export async function writeProductCatalogSnapshot(factoryOutputRoots, outputPathValue) {
  const outputPath = path.resolve(outputPathValue);
  const catalog = await buildProductCatalog(factoryOutputRoots.map((entry) => path.resolve(entry)));
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, serialized, "utf8");
  await rename(temporaryPath, outputPath);
  return catalog;
}

async function loadFactoryOutput(outputRootValue) {
  const outputRoot = path.resolve(outputRootValue);
  const releases = await discoverReleases(path.join(outputRoot, FACTORY_PATHS.releaseDirectory));
  const [gates, verification, runtimeResults, comparisonResults] = await Promise.all([
    readJson(path.join(outputRoot, FACTORY_PATHS.gates)),
    readJson(path.join(outputRoot, FACTORY_PATHS.verification)),
    readFirstJsonIfPresent(outputRoot, FACTORY_PATHS.runtimeResults),
    readFirstJsonIfPresent(outputRoot, FACTORY_PATHS.comparisonResults)
  ]);

  return releases.map((release) => ({
    product_id: release.product_id,
    creator_id: release.creator_id,
    release_id: release.release_id,
    release_digest: release.digest,
    version: release.version,
    name: release.product.name,
    description: release.product.description,
    promise: release.product.promise,
    boundaries: release.product.boundaries,
    price_minor: release.product.price.amount_minor,
    currency: release.product.price.currency,
    pricing_model: release.product.price.model ?? null,
    publication: summarizePublication({ release, gates, verification, runtimeResults, comparisonResults })
  }));
}

async function discoverReleases(releaseRoot) {
  const releases = [];
  for (const releaseIdEntry of await directoryEntries(releaseRoot)) {
    if (!releaseIdEntry.isDirectory()) continue;
    const releaseIdRoot = path.join(releaseRoot, releaseIdEntry.name);
    for (const digestEntry of await directoryEntries(releaseIdRoot)) {
      if (!digestEntry.isDirectory() || !digestEntry.name.startsWith("sha256:")) continue;
      const release = await readJson(path.join(releaseIdRoot, digestEntry.name, "public.json"));
      validateFactoryRelease(release);
      if (release.release_id !== releaseIdEntry.name || release.digest !== digestEntry.name) {
        throw new Error(`Factory Release path does not match its identity: ${release.release_id}`);
      }
      releases.push(release);
    }
  }
  if (releases.length === 0) throw new Error(`Factory output contains no Creator Release: ${releaseRoot}`);
  return releases;
}

async function directoryEntries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Factory output is incomplete: ${directory}`);
    throw error;
  }
}

function assertUniqueReleaseIdentities(products) {
  const seen = new Set();
  for (const product of products) {
    const key = releaseKey(product);
    if (seen.has(key)) throw new Error(`Duplicate Creator Release configured: ${key}`);
    seen.add(key);
  }
}

function summarizePublication({ release, gates, verification, runtimeResults, comparisonResults }) {
  const identityMatches = verification.release_id === release.release_id
    && verification.release_digest === release.digest;
  const factoryPassed = gates.passed === true && verification.passed === true && identityMatches;
  const runtimePassed = evidenceMatches(runtimeResults, release) && runtimeResults.passed === true;
  const comparisonPassed = evidenceMatches(comparisonResults, release)
    && comparisonResults.passed === true
    && comparisonResults.gate?.passed === true
    && Number(comparisonResults.summary?.creator_agent?.pass_rate) >= 0.8
    && Number(comparisonResults.summary?.delta) > 0;
  const ready = factoryPassed && runtimePassed && comparisonPassed;
  return {
    status: ready ? "ready" : "preparing",
    summary: ready
      ? "This version completed Hatch's release gates and can be published."
      : "Hatch is preparing this version for publication."
  };
}

function evidenceMatches(evidence, release) {
  return evidence?.release_id === release.release_id
    && evidence?.release_digest === release.digest;
}


function validateFactoryRelease(release) {
  const digestPattern = /^sha256:[0-9a-f]{64}$/;
  if (!release?.creator_id || !release?.product_id || !release?.release_id) {
    throw new Error("Factory public.json is missing Creator Release identity.");
  }
  if (!digestPattern.test(release.digest ?? "")) {
    throw new Error("Factory public.json does not contain a real sha256 digest.");
  }
  if (!release.product?.name || !Number.isInteger(release.product?.price?.amount_minor)) {
    throw new Error("Factory public.json is missing public product metadata.");
  }
}

function compareVersions(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function releaseKey(product) {
  return `${product.release_id}|${product.release_digest}`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readJsonIfPresent(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readFirstJsonIfPresent(root, relativePaths) {
  for (const relativePath of relativePaths) {
    const value = await readJsonIfPresent(path.join(root, relativePath));
    if (value) return value;
  }
  return null;
}
