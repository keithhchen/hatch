import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalArtifactObjectStore } from "./creatorLearning/objectStore.js";
import { CreatorSourceLibrary } from "./creatorLearning/sourceLibrary.js";
import { InMemoryDistillationGraphStore } from "./creatorLearning/distillationGraph.js";

test("Source Library keeps originals, projects non-images to Markdown, and preserves native images", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-source-library-"));
  const objectRoot = await mkdtemp(path.join(os.tmpdir(), "hatch-source-objects-"));
  const graph = new InMemoryDistillationGraphStore();
  const library = new CreatorSourceLibrary(root, new LocalArtifactObjectStore(objectRoot), graph);
  await library.initialize();
  const csv = await library.createFromUpload("creator_1", {
    taskId: "task_1",
    displayName: "rules.csv",
    bytes: Buffer.from("Rule,Decision\nA,Keep\n", "utf8")
  });
  assert.equal(csv.projection.kind, "markdown");
  assert.match(csv.projectionContent ?? "", /\| Rule \| Decision \|/);
  const png = await library.createFromUpload("creator_1", {
    taskId: "task_1",
    displayName: "diagram.png",
    mediaType: "image/png",
    bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
  });
  assert.equal(png.projection.kind, "image");
  assert.equal(png.projectionBase64, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString("base64"));
  const snapshot = await library.createSnapshot("creator_1", { taskId: "task_1", documentIds: [csv.id, png.id] });
  assert.equal(snapshot.lockedAt, snapshot.createdAt);
  assert.deepEqual((await library.resolveSnapshotSources("creator_1", snapshot.id)).map((source) => Boolean(source.image)), [false, true]);
  const graphState = await graph.derive("task_1");
  assert.equal(graphState.status, "running");
});

test("Local Object Store enforces immutable keys and permits only explicit mutable projections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-object-store-"));
  const store = new LocalArtifactObjectStore(root);
  await store.put("artifacts/a", "one");
  await store.put("artifacts/a", "one");
  await assert.rejects(() => store.put("artifacts/a", "two"), /Immutable/);
  await store.put("state.json", "one", { immutable: false });
  await store.put("state.json", "two", { immutable: false });
  assert.equal((await store.get("state.json")).toString(), "two");
});
