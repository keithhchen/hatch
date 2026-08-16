import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canGenerateProductVersion,
  productFileState,
  shouldPollProductFiles
} from "./creatorProductFilesUi.js";

const readyFile = {
  id: "file-ready",
  projection: { kind: "markdown", sha256: "abc", content_ref: "products/p/files/file-ready/projection.md" }
};

const publicReadyFile = {
  id: "file-public-ready",
  projection: { kind: "markdown", sha256: "def", bytes: 124 }
};

const publicReadyImage = {
  id: "image-public-ready",
  projection: { kind: "image", media_type: "image/png", sha256: "fed", bytes: 512 }
};

test("Product Files only become ready from an explicit ready state or a complete projection", () => {
  assert.equal(productFileState(readyFile), "ready");
  assert.equal(productFileState(publicReadyFile), "ready");
  assert.equal(productFileState(publicReadyImage), "ready");
  assert.equal(productFileState({ id: "artifact-only", artifact_id: "artifact-1" }), "processing");
  assert.equal(productFileState({ id: "empty-projection", projection: { kind: "markdown", sha256: "abc", bytes: 0 } }), "processing");
  assert.equal(productFileState({ id: "invalid-projection", projection: { kind: "markdown", sha256: "abc", bytes: "124" } }), "processing");
  assert.equal(productFileState({ ...readyFile, status: "queued" }), "processing");
  assert.equal(productFileState({ ...readyFile, status: "projection_failed" }), "error");
});

test("Product version generation waits for every authoritative file state", () => {
  const queuedFile = { id: "file-queued", status: "queued" };
  assert.equal(shouldPollProductFiles([readyFile, queuedFile]), true);
  assert.equal(canGenerateProductVersion([readyFile, queuedFile]), false);
  assert.equal(canGenerateProductVersion([readyFile]), true);
  assert.equal(canGenerateProductVersion([publicReadyFile, publicReadyImage]), true);
  assert.equal(canGenerateProductVersion([]), false);
});

test("both real Product Files entrypoints poll the authoritative file collection", () => {
  for (const fileName of ["CreatorProductWorkspace.jsx", "CreatorSourceLibrary.jsx"]) {
    const source = readFileSync(new URL(fileName, import.meta.url), "utf8");
    assert.match(source, /shouldPollProductFiles/);
    assert.match(source, /await listProductFiles\(token, productId\)/);
    assert.match(source, /setInterval\(\(\) => \{ void poll\(\); \}, 2000\)/);
    assert.match(source, /canGenerateProductVersion/);
  }
});
