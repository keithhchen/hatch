import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";
import { PostgresDistillationGraphStore } from "./distillationGraphStore.js";
import type { PostgresQueryExecutor } from "../postgresStore.js";

test("Postgres graph artifact registration preserves the caller-owned immutable timestamp", async () => {
  const pool = new ArtifactPostgresFake();
  const graph = new PostgresDistillationGraphStore(pool);
  const artifact = {
    artifactId: "art_timestamped",
    taskId: "task_1",
    kind: "llm_output" as const,
    objectKey: "factory-runs/run_1/artifacts/output.md",
    sha256: `sha256:${"a".repeat(64)}`,
    bytes: 12,
    mediaType: "text/plain",
    createdAt: "2026-08-14T22:12:00.123Z"
  };

  const first = await graph.registerArtifact(artifact);
  const second = await graph.registerArtifact(artifact);

  assert.equal(first.createdAt, artifact.createdAt);
  assert.deepEqual(second, first);
  assert.equal(pool.insertValues?.[9], artifact.createdAt);
});

class ArtifactPostgresFake implements PostgresQueryExecutor {
  private row?: QueryResultRow;
  insertValues?: unknown[];

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    if (/^\s*CREATE TABLE/i.test(text)) return { rows: [] };
    if (/SELECT \* FROM hatch_creator_distillation_artifacts WHERE artifact_id/i.test(text)) {
      return { rows: this.row ? [this.row as T] : [] };
    }
    if (/INSERT INTO hatch_creator_distillation_artifacts/i.test(text)) {
      this.insertValues = values;
      this.row = {
        artifact_id: values[0],
        task_id: values[1],
        run_id: values[2],
        revision_id: values[3],
        kind: values[4],
        object_key: values[5],
        sha256: values[6],
        bytes: values[7],
        media_type: values[8],
        created_at: values[9]
      };
      return { rows: [this.row as T] };
    }
    throw new Error(`Unexpected SQL in artifact fake: ${text.slice(0, 120)}`);
  }
}
