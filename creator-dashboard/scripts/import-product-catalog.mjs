#!/usr/bin/env node

import path from "node:path";
import { writeProductCatalogSnapshot } from "../src/catalog-import.js";

const { output, factoryOutputs } = parseArguments(process.argv.slice(2));
const catalog = await writeProductCatalogSnapshot(factoryOutputs, output);
process.stdout.write(`${JSON.stringify({
  output: path.resolve(output),
  products: catalog.products.length,
  releases: catalog.products.map((product) => ({
    creator_id: product.creator_id,
    product_id: product.product_id,
    release_id: product.release_id,
    release_digest: product.release_digest
  }))
}, null, 2)}\n`);

function parseArguments(values) {
  const factoryOutputs = [];
  let output;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const next = values[index + 1];
    if ((value === "--factory-output" || value === "--output") && (!next || next.startsWith("--"))) {
      throw new Error(`Missing value for ${value}`);
    }
    if (value === "--factory-output") {
      factoryOutputs.push(next);
      index += 1;
    } else if (value === "--output") {
      output = next;
      index += 1;
    } else {
      throw new Error(`Unexpected argument: ${value}`);
    }
  }
  if (!output || factoryOutputs.length === 0) {
    throw new Error("Usage: import-product-catalog --factory-output <completed-output> [--factory-output <completed-output> ...] --output <catalog.json>");
  }
  return { output, factoryOutputs };
}
