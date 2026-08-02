import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export class CreatorProductStore {
  #records;
  #states;

  constructor({ records, states, statePath }) {
    this.#records = records;
    this.#states = states;
    this.statePath = statePath;
  }

  static async open({ catalogPath, statePath }) {
    if (!catalogPath) throw new Error("A Dashboard product catalog path is required.");
    const catalog = await readCatalog(catalogPath);
    const records = catalog.products.map(normalizeCatalogProduct);
    assertUniqueReleaseIdentities(records);
    const persisted = await readJsonIfPresent(statePath);
    const states = normalizePersistedStates(persisted, records);
    return new CreatorProductStore({ records, states, statePath });
  }

  listForCreator(creatorId) {
    const latestByProduct = new Map();
    for (const record of this.#records.filter((product) => product.creator_id === creatorId)) {
      const current = latestByProduct.get(record.product_id);
      if (!current || compareVersions(record.version, current.version) > 0) {
        latestByProduct.set(record.product_id, record);
      }
    }
    return [...latestByProduct.values()]
      .map((record) => this.#releaseProduct(record))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getForCreator(creatorId, productId) {
    return this.listForCreator(creatorId).find((product) => product.product_id === productId) ?? null;
  }

  getPublishRequest(creatorId, productId) {
    const product = this.getForCreator(creatorId, productId);
    if (!product || product.status !== "ready_to_publish" || product.publication.status !== "ready") return null;
    return {
      release_id: product.release_id,
      release_digest: product.release_digest
    };
  }

  async markPublished(registryRecord) {
    const record = this.#records.find((product) => (
      product.release_id === registryRecord.release_id
      && product.release_digest === registryRecord.release_digest
    ));
    if (
      !record
      || registryRecord.creator_id !== record.creator_id
      || registryRecord.product_id !== record.product_id
    ) {
      throw new Error("Registry returned a different Creator Release identity.");
    }

    const key = releaseKey(record);
    const nextStates = { ...this.#states, [key]: {
      status: "published",
      published_at: registryRecord.published_at,
      release_id: registryRecord.release_id,
      release_digest: registryRecord.release_digest
    } };
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ releases: nextStates }, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.statePath);
    } finally {
      await unlink(temporaryPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    this.#states = nextStates;
    return this.#releaseProduct(record);
  }

  #releaseProduct(record) {
    const state = this.#states[releaseKey(record)];
    return {
      product_id: record.product_id,
      creator_id: record.creator_id,
      name: record.name,
      description: record.description,
      promise: record.promise,
      boundaries: record.boundaries,
      status: state?.status === "published"
        ? "published"
        : record.publication.status === "ready" ? "ready_to_publish" : "preparing",
      price_minor: record.price_minor,
      currency: record.currency,
      pricing_model: record.pricing_model,
      release_id: record.release_id,
      release_digest: record.release_digest,
      version: record.version,
      published_at: state?.published_at ?? null,
      publication: record.publication
    };
  }
}

async function readCatalog(catalogPathValue) {
  const catalogPath = path.resolve(catalogPathValue);
  let catalog;
  try {
    catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && process.env.HATCH_CREATOR_DASHBOARD_ALLOW_EMPTY_CATALOG === "1") {
      return { schema_version: "1", products: [] };
    }
    if (error?.code === "ENOENT") throw new Error(`Dashboard product catalog does not exist: ${catalogPath}`);
    throw error;
  }
    if (catalog?.schema_version !== "1" || !Array.isArray(catalog.products)
      || (catalog.products.length === 0 && process.env.HATCH_CREATOR_DASHBOARD_ALLOW_EMPTY_CATALOG !== "1")) {
      throw new Error("Dashboard product catalog is invalid or empty.");
    }
  return catalog;
}

function normalizeCatalogProduct(value) {
  const digestPattern = /^sha256:[0-9a-f]{64}$/;
  const requiredStrings = ["product_id", "creator_id", "release_id", "version", "name", "description", "promise", "currency"];
  if (!value || requiredStrings.some((key) => typeof value[key] !== "string" || !value[key])) {
    throw new Error("Dashboard product catalog contains incomplete product metadata.");
  }
  if (!digestPattern.test(value.release_digest ?? "") || !Number.isInteger(value.price_minor)) {
    throw new Error(`Dashboard product catalog contains invalid Release metadata: ${value.release_id}`);
  }
  if (!value.publication || !["ready", "preparing"].includes(value.publication.status)) {
    throw new Error(`Dashboard product catalog contains an invalid publication state: ${value.release_id}`);
  }
  return {
    product_id: value.product_id,
    creator_id: value.creator_id,
    release_id: value.release_id,
    release_digest: value.release_digest,
    version: value.version,
    name: value.name,
    description: value.description,
    promise: value.promise,
    boundaries: Array.isArray(value.boundaries) ? value.boundaries.map(String) : [],
    price_minor: value.price_minor,
    currency: value.currency,
    pricing_model: value.pricing_model ?? null,
    publication: normalizePublication(value.publication)
  };
}

function normalizePublication(value) {
  return {
    status: value.status,
    summary: String(value.summary ?? "")
  };
}

function compareVersions(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function assertUniqueReleaseIdentities(records) {
  const seen = new Set();
  for (const record of records) {
    const key = releaseKey(record);
    if (seen.has(key)) throw new Error(`Duplicate Creator Release configured: ${key}`);
    seen.add(key);
  }
}

function normalizePersistedStates(persisted, records) {
  const states = persisted?.releases && typeof persisted.releases === "object"
    ? { ...persisted.releases }
    : {};
  const configured = new Set(records.map(releaseKey));
  return Object.fromEntries(Object.entries(states).filter(([key]) => configured.has(key)));
}

function releaseKey(product) {
  return `${product.release_id}|${product.release_digest}`;
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
