import type { QueryResultRow } from "pg";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import {
  deriveDistillationState,
  validateArtifact,
  type DistillationEvent,
  type DistillationGraphStore,
  type DistillationRelease,
  type DistillationRun,
  type DistillationRunRevision,
  type DistillationNodeExecution,
  type ImmutableArtifactRecord,
  type QualityGateAssessment
} from "./distillationGraph.js";

/** Control-plane tables. Payloads contain only host-owned metadata and refs. */
export const POSTGRES_DISTILLATION_GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_creator_distillation_artifacts (
  artifact_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT,
  revision_id TEXT,
  kind TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes BIGINT NOT NULL CHECK (bytes >= 0),
  media_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (object_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS hatch_creator_distillation_artifacts_object_key_uq
  ON hatch_creator_distillation_artifacts (object_key);
CREATE TABLE IF NOT EXISTS hatch_creator_distillation_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  creator_id TEXT NOT NULL,
  product_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS hatch_creator_distillation_revisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES hatch_creator_distillation_runs(id),
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  source_snapshot_id TEXT NOT NULL,
  parent_revision_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, revision)
);
CREATE INDEX IF NOT EXISTS hatch_creator_distillation_revisions_task_idx
  ON hatch_creator_distillation_revisions (task_id, revision DESC);
CREATE TABLE IF NOT EXISTS hatch_creator_distillation_node_executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES hatch_creator_distillation_revisions(id),
  node TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL,
  input_artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS hatch_creator_distillation_node_exec_revision_idx
  ON hatch_creator_distillation_node_executions (revision_id, node, attempt);
CREATE INDEX IF NOT EXISTS hatch_creator_distillation_artifacts_task_idx
  ON hatch_creator_distillation_artifacts (task_id, created_at DESC);
CREATE TABLE IF NOT EXISTS hatch_creator_distillation_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL,
  sequence BIGSERIAL NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  revision_id TEXT,
  type TEXT NOT NULL,
  node TEXT,
  actor TEXT NOT NULL,
  parent_event_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_id, event_key)
);
CREATE INDEX IF NOT EXISTS hatch_creator_distillation_events_task_seq_idx
  ON hatch_creator_distillation_events (task_id, sequence);
CREATE TABLE IF NOT EXISTS hatch_creator_quality_gate_assessments (
  id TEXT PRIMARY KEY,
  gate_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  name TEXT NOT NULL,
  critical BOOLEAN NOT NULL,
  status TEXT NOT NULL,
  evidence_artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason TEXT,
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS hatch_creator_quality_gates_revision_idx
  ON hatch_creator_quality_gate_assessments (revision_id, assessed_at);
CREATE TABLE IF NOT EXISTS hatch_creator_distillation_releases (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  corpus_artifact_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS hatch_creator_distillation_releases_revision_product_uq
  ON hatch_creator_distillation_releases (task_id, revision_id, product_id);
CREATE INDEX IF NOT EXISTS hatch_creator_distillation_releases_task_idx
  ON hatch_creator_distillation_releases (task_id, created_at DESC);
`;

export class PostgresDistillationGraphStore implements DistillationGraphStore {
  private schemaPromise?: Promise<void>;

  constructor(private readonly pool: PostgresQueryExecutor) {}

  async initialize(): Promise<void> {
    this.schemaPromise ??= this.pool.query(POSTGRES_DISTILLATION_GRAPH_SCHEMA).then(() => undefined);
    await this.schemaPromise;
  }

  async ensureRun(run: DistillationRun): Promise<DistillationRun> {
    await this.initialize();
    const existing = await this.pool.query<RunRow>(`SELECT * FROM hatch_creator_distillation_runs WHERE id = $1`, [run.id]);
    if (existing.rows[0]) {
      const current = runFromRow(existing.rows[0]);
      // The lineage timestamp belongs to the first insertion. A later
      // revision may call ensureRun with a new request timestamp, but must
      // reuse the stored immutable Run record.
      assertSameJson(runIdentity(current), runIdentity(run), `Distillation Run ${run.id} is immutable`);
      return current;
    }
    const result = await this.pool.query<RunRow>(`
      INSERT INTO hatch_creator_distillation_runs (id, task_id, creator_id, product_id, created_at)
      VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, clock_timestamp()))
      ON CONFLICT (task_id) DO UPDATE SET id = hatch_creator_distillation_runs.id
      RETURNING *
    `, [run.id, run.taskId, run.creatorId, run.productId ?? null, run.createdAt]);
    const current = runFromRow(result.rows[0]!);
    if (current.id !== run.id) throw new Error(`Task ${run.taskId} is already attached to another Distillation Run`);
    return current;
  }

  async createRevision(revision: DistillationRunRevision): Promise<DistillationRunRevision> {
    await this.initialize();
    const existing = await this.pool.query<RevisionRow>(`SELECT * FROM hatch_creator_distillation_revisions WHERE id = $1`, [revision.id]);
    if (existing.rows[0]) { const current = revisionFromRow(existing.rows[0]); assertSameJson(current, revision, `RunRevision ${revision.id} is immutable`); return current; }
    const run = await this.pool.query<{ id: string; task_id: string }>(`SELECT id, task_id FROM hatch_creator_distillation_runs WHERE id = $1`, [revision.runId]);
    if (!run.rows[0] || run.rows[0].task_id !== revision.taskId) throw new Error(`RunRevision references an unknown Distillation Run ${revision.runId}`);
    if (revision.parentRevisionId) {
      const parent = await this.pool.query<{ id: string; run_id: string; task_id: string; revision: string | number }>(`SELECT id, run_id, task_id, revision FROM hatch_creator_distillation_revisions WHERE id = $1`, [revision.parentRevisionId]);
      if (!parent.rows[0] || parent.rows[0].run_id !== revision.runId || parent.rows[0].task_id !== revision.taskId || Number(parent.rows[0].revision) >= revision.revision) {
        throw new Error(`RunRevision parent ${revision.parentRevisionId} is invalid`);
      }
    }
    try {
      const result = await this.pool.query<RevisionRow>(`
        INSERT INTO hatch_creator_distillation_revisions (id, run_id, task_id, revision, source_snapshot_id, parent_revision_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, clock_timestamp()))
        RETURNING *
      `, [revision.id, revision.runId, revision.taskId, revision.revision, revision.sourceSnapshotId, revision.parentRevisionId ?? null, revision.createdAt]);
      return revisionFromRow(result.rows[0]!);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const duplicate = await this.pool.query<RevisionRow>(`SELECT * FROM hatch_creator_distillation_revisions WHERE id = $1`, [revision.id]);
      if (duplicate.rows[0]) {
        const current = revisionFromRow(duplicate.rows[0]);
        assertSameJson(current, revision, `RunRevision ${revision.id} is immutable`);
        return current;
      }
      throw error;
    }
  }

  async recordNodeExecution(execution: DistillationNodeExecution): Promise<DistillationNodeExecution> {
    await this.initialize();
    const existing = await this.pool.query<NodeExecutionRow>(`SELECT * FROM hatch_creator_distillation_node_executions WHERE id = $1`, [execution.id]);
    if (existing.rows[0]) { const current = nodeExecutionFromRow(existing.rows[0]); assertSameJson(current, execution, `Node execution ${execution.id} is immutable`); return current; }
    await assertPostgresRevisionRef(this.pool, execution.taskId, execution.runId, execution.revisionId, "Node execution");
    await assertPostgresArtifactRefs(this.pool, execution.taskId, execution.revisionId, [...execution.inputArtifactIds, ...execution.outputArtifactIds]);
    const result = await this.pool.query<NodeExecutionRow>(`
      INSERT INTO hatch_creator_distillation_node_executions
        (id, task_id, run_id, revision_id, node, attempt, status, input_artifact_ids, output_artifact_ids, started_at, completed_at, error_code)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::timestamptz, $11::timestamptz, $12)
      RETURNING *
    `, [execution.id, execution.taskId, execution.runId, execution.revisionId, execution.node, execution.attempt, execution.status, JSON.stringify(execution.inputArtifactIds), JSON.stringify(execution.outputArtifactIds), execution.startedAt ?? null, execution.completedAt ?? null, execution.errorCode ?? null]);
    return nodeExecutionFromRow(result.rows[0]!);
  }

  async registerArtifact(record: ImmutableArtifactRecord): Promise<ImmutableArtifactRecord> {
    await this.initialize();
    validateArtifact(record);
    if (record.revisionId) {
      await assertPostgresRevisionRef(this.pool, record.taskId, record.runId ?? "", record.revisionId, "Artifact");
    } else if (record.runId) {
      await assertPostgresRunTaskRef(this.pool, record.runId, record.taskId);
    }
    const existing = await this.pool.query<ArtifactRow>(`
      SELECT * FROM hatch_creator_distillation_artifacts WHERE artifact_id = $1
    `, [record.artifactId]);
    if (existing.rows[0]) {
      const current = artifactFromRow(existing.rows[0]);
      assertSameJson(current, record, `Artifact ${record.artifactId} is immutable`);
      return current;
    }
    try {
      const result = await this.pool.query<ArtifactRow>(`
        INSERT INTO hatch_creator_distillation_artifacts
          (artifact_id, task_id, run_id, revision_id, kind, object_key, sha256, bytes, media_type, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
        RETURNING *
      `, [record.artifactId, record.taskId, record.runId ?? null, record.revisionId ?? null, record.kind, record.objectKey, record.sha256, record.bytes, record.mediaType, record.createdAt]);
      return artifactFromRow(result.rows[0]!);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const duplicate = await this.pool.query<ArtifactRow>(`SELECT * FROM hatch_creator_distillation_artifacts WHERE artifact_id = $1`, [record.artifactId]);
      const current = duplicate.rows[0] ? artifactFromRow(duplicate.rows[0]) : undefined;
      if (!current) throw error;
      assertSameJson(current, record, `Artifact ${record.artifactId} is immutable`);
      return current;
    }
  }

  async getArtifact(artifactId: string): Promise<ImmutableArtifactRecord | undefined> {
    await this.initialize();
    const result = await this.pool.query<ArtifactRow>(`SELECT * FROM hatch_creator_distillation_artifacts WHERE artifact_id = $1`, [artifactId]);
    return result.rows[0] ? artifactFromRow(result.rows[0]) : undefined;
  }

  async appendEvent(input: Parameters<DistillationGraphStore["appendEvent"]>[0]): Promise<DistillationEvent> {
    await this.initialize();
    const existing = await this.pool.query<EventRow>(`
      SELECT * FROM hatch_creator_distillation_events WHERE task_id = $1 AND event_key = $2
    `, [input.taskId, input.eventKey]);
    if (existing.rows[0]) return eventFromRow(existing.rows[0]);
    await assertPostgresRunTaskRef(this.pool, input.runId, input.taskId);
    if (input.revisionId) await assertPostgresRevisionRef(this.pool, input.taskId, input.runId, input.revisionId, "Event");
    if (input.parentEventIds.length) {
      const parents = await this.pool.query<{ id: string; task_id: string }>(`
        SELECT id, task_id FROM hatch_creator_distillation_events WHERE id = ANY($1::text[])
      `, [input.parentEventIds]);
      if (parents.rows.length !== input.parentEventIds.length || parents.rows.some((parent) => parent.task_id !== input.taskId)) {
        throw new Error("Event graph parent is missing or belongs to another Task");
      }
    }
    if (input.artifactIds.length) {
      await assertPostgresArtifactRefs(this.pool, input.taskId, input.revisionId, input.artifactIds);
    }
    try {
      const result = await this.pool.query<EventRow>(`
        INSERT INTO hatch_creator_distillation_events
          (id, event_key, task_id, run_id, revision_id, type, node, actor, parent_event_ids, artifact_ids, payload, occurred_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, COALESCE($12::timestamptz, clock_timestamp()))
        RETURNING *
      `, [input.id, input.eventKey, input.taskId, input.runId, input.revisionId ?? null, input.type, input.node ?? null, input.actor, JSON.stringify(input.parentEventIds), JSON.stringify(input.artifactIds), JSON.stringify(input.payload), input.occurredAt ?? null]);
      return eventFromRow(result.rows[0]!);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const duplicate = await this.pool.query<EventRow>(`SELECT * FROM hatch_creator_distillation_events WHERE task_id = $1 AND event_key = $2`, [input.taskId, input.eventKey]);
      if (!duplicate.rows[0]) throw error;
      return eventFromRow(duplicate.rows[0]);
    }
  }

  async listEvents(taskId: string): Promise<DistillationEvent[]> {
    await this.initialize();
    const result = await this.pool.query<EventRow>(`
      SELECT * FROM hatch_creator_distillation_events WHERE task_id = $1 ORDER BY sequence ASC
    `, [taskId]);
    return result.rows.map(eventFromRow);
  }

  async recordGate(input: Parameters<DistillationGraphStore["recordGate"]>[0]): Promise<QualityGateAssessment> {
    await this.initialize();
    const existing = await this.pool.query<GateRow>(`SELECT * FROM hatch_creator_quality_gate_assessments WHERE id = $1`, [input.id]);
    if (existing.rows[0]) {
      const current = gateFromRow(existing.rows[0]);
      assertSameJson(current, { ...input, assessedAt: current.assessedAt }, `Gate assessment ${input.id} is immutable`);
      return current;
    }
    await assertPostgresRevisionRef(this.pool, input.taskId, input.runId, input.revisionId, "Gate assessment");
    await assertPostgresArtifactRefs(this.pool, input.taskId, input.revisionId, input.evidenceArtifactIds);
    const result = await this.pool.query<GateRow>(`
      INSERT INTO hatch_creator_quality_gate_assessments
        (id, gate_key, task_id, run_id, revision_id, name, critical, status, evidence_artifact_ids, reason, assessed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, COALESCE($11::timestamptz, clock_timestamp()))
      RETURNING *
    `, [input.id, input.gateKey, input.taskId, input.runId, input.revisionId, input.name, input.critical, input.status, JSON.stringify(input.evidenceArtifactIds), input.reason ?? null, input.assessedAt ?? null]);
    return gateFromRow(result.rows[0]!);
  }

  async listGates(revisionId: string): Promise<QualityGateAssessment[]> {
    await this.initialize();
    const result = await this.pool.query<GateRow>(`
      SELECT * FROM hatch_creator_quality_gate_assessments WHERE revision_id = $1 ORDER BY assessed_at ASC, id ASC
    `, [revisionId]);
    return result.rows.map(gateFromRow);
  }

  async recordRelease(release: DistillationRelease): Promise<DistillationRelease> {
    await this.initialize();
    const existing = await this.pool.query<ReleaseRow>(`SELECT * FROM hatch_creator_distillation_releases WHERE id = $1`, [release.id]);
    if (existing.rows[0]) {
      const current = releaseFromRow(existing.rows[0]);
      assertSameJson(current, release, `Release ${release.id} is immutable`);
      return current;
    }
    await assertPostgresRevisionRef(this.pool, release.taskId, release.runId, release.revisionId, "Release");
    const artifact = await this.pool.query<{ artifact_id: string; kind: ImmutableArtifactRecord["kind"] }>(`SELECT artifact_id, kind FROM hatch_creator_distillation_artifacts WHERE artifact_id = $1`, [release.corpusArtifactId]);
    if (!artifact.rows[0]) throw new Error(`Release references unknown Corpus Artifact ${release.corpusArtifactId}`);
    if (artifact.rows[0].kind !== "corpus_bundle") throw new Error(`Release references a non-corpus Artifact ${release.corpusArtifactId}`);
    await assertPostgresArtifactRefs(this.pool, release.taskId, release.revisionId, [release.corpusArtifactId]);
    try {
      const result = await this.pool.query<ReleaseRow>(`
        INSERT INTO hatch_creator_distillation_releases (id, task_id, run_id, revision_id, product_id, corpus_artifact_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, clock_timestamp()))
        RETURNING *
      `, [release.id, release.taskId, release.runId, release.revisionId, release.productId, release.corpusArtifactId, release.createdAt]);
      return releaseFromRow(result.rows[0]!);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const duplicate = await this.pool.query<ReleaseRow>(`SELECT * FROM hatch_creator_distillation_releases WHERE id = $1`, [release.id]);
      if (duplicate.rows[0]) {
        const current = releaseFromRow(duplicate.rows[0]);
        assertSameJson(current, release, `Release ${release.id} is immutable`);
        return current;
      }
      throw error;
    }
  }

  async derive(taskId: string) {
    const [events, gates] = await Promise.all([this.listEvents(taskId), this.listAllGates(taskId)]);
    const releases = await this.pool.query<ReleaseRow>(`SELECT * FROM hatch_creator_distillation_releases WHERE task_id = $1 ORDER BY created_at ASC, id ASC`, [taskId]);
    return deriveDistillationState(taskId, events, gates, releases.rows.length ? releaseFromRow(releases.rows.at(-1)!) : undefined);
  }

  private async listAllGates(taskId: string): Promise<QualityGateAssessment[]> {
    const result = await this.pool.query<GateRow>(`SELECT * FROM hatch_creator_quality_gate_assessments WHERE task_id = $1 ORDER BY assessed_at ASC, id ASC`, [taskId]);
    return result.rows.map(gateFromRow);
  }
}

type ArtifactRow = QueryResultRow & { artifact_id: string; task_id: string; run_id: string | null; revision_id: string | null; kind: ImmutableArtifactRecord["kind"]; object_key: string; sha256: string; bytes: string | number; media_type: string; created_at: string | Date };
type RunRow = QueryResultRow & { id: string; task_id: string; creator_id: string; product_id: string | null; created_at: string | Date };
type RevisionRow = QueryResultRow & { id: string; run_id: string; task_id: string; revision: string | number; source_snapshot_id: string; parent_revision_id: string | null; created_at: string | Date };
type NodeExecutionRow = QueryResultRow & { id: string; task_id: string; run_id: string; revision_id: string; node: DistillationNodeExecution["node"]; attempt: string | number; status: DistillationNodeExecution["status"]; input_artifact_ids: unknown; output_artifact_ids: unknown; started_at: string | Date | null; completed_at: string | Date | null; error_code: string | null };
type EventRow = QueryResultRow & { id: string; event_key: string; sequence: string | number; task_id: string; run_id: string; revision_id: string | null; type: DistillationEvent["type"]; node: DistillationEvent["node"] | null; actor: DistillationEvent["actor"]; parent_event_ids: unknown; artifact_ids: unknown; payload: unknown; occurred_at: string | Date };
type GateRow = QueryResultRow & { id: string; gate_key: string; task_id: string; run_id: string; revision_id: string; name: QualityGateAssessment["name"]; critical: boolean; status: QualityGateAssessment["status"]; evidence_artifact_ids: unknown; reason: string | null; assessed_at: string | Date };
type ReleaseRow = QueryResultRow & { id: string; task_id: string; run_id: string; revision_id: string; product_id: string; corpus_artifact_id: string; created_at: string | Date };

function artifactFromRow(row: ArtifactRow): ImmutableArtifactRecord { return { artifactId: row.artifact_id, taskId: row.task_id, ...(row.run_id ? { runId: row.run_id } : {}), ...(row.revision_id ? { revisionId: row.revision_id } : {}), kind: row.kind, objectKey: row.object_key, sha256: row.sha256, bytes: Number(row.bytes), mediaType: row.media_type, createdAt: iso(row.created_at) }; }
function runFromRow(row: RunRow): DistillationRun { return { id: row.id, taskId: row.task_id, creatorId: row.creator_id, ...(row.product_id ? { productId: row.product_id } : {}), createdAt: iso(row.created_at) }; }
function revisionFromRow(row: RevisionRow): DistillationRunRevision { return { id: row.id, runId: row.run_id, taskId: row.task_id, revision: Number(row.revision), sourceSnapshotId: row.source_snapshot_id, ...(row.parent_revision_id ? { parentRevisionId: row.parent_revision_id } : {}), createdAt: iso(row.created_at) }; }
function nodeExecutionFromRow(row: NodeExecutionRow): DistillationNodeExecution { return { id: row.id, taskId: row.task_id, runId: row.run_id, revisionId: row.revision_id, node: row.node, attempt: Number(row.attempt), status: row.status, inputArtifactIds: jsonArray(row.input_artifact_ids), outputArtifactIds: jsonArray(row.output_artifact_ids), ...(row.started_at ? { startedAt: iso(row.started_at) } : {}), ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}) }; }
function eventFromRow(row: EventRow): DistillationEvent { return { id: row.id, eventKey: row.event_key, sequence: Number(row.sequence), taskId: row.task_id, runId: row.run_id, ...(row.revision_id ? { revisionId: row.revision_id } : {}), type: row.type, ...(row.node ? { node: row.node } : {}), actor: row.actor, parentEventIds: jsonArray(row.parent_event_ids), artifactIds: jsonArray(row.artifact_ids), payload: jsonObject(row.payload), occurredAt: iso(row.occurred_at) }; }
function gateFromRow(row: GateRow): QualityGateAssessment { return { id: row.id, gateKey: row.gate_key, taskId: row.task_id, runId: row.run_id, revisionId: row.revision_id, name: row.name, critical: row.critical, status: row.status, evidenceArtifactIds: jsonArray(row.evidence_artifact_ids), ...(row.reason ? { reason: row.reason } : {}), assessedAt: iso(row.assessed_at) }; }
function releaseFromRow(row: ReleaseRow): DistillationRelease { return { id: row.id, taskId: row.task_id, runId: row.run_id, revisionId: row.revision_id, productId: row.product_id, corpusArtifactId: row.corpus_artifact_id, createdAt: iso(row.created_at) }; }
function jsonArray(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : []; }
function jsonObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function iso(value: string | Date): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function assertSameJson(left: unknown, right: unknown, message: string): void { if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(message); }

function runIdentity(run: DistillationRun): Omit<DistillationRun, "createdAt"> {
  const { createdAt: _createdAt, ...identity } = run;
  return identity;
}
function isUniqueViolation(error: unknown): boolean { return !!error && typeof error === "object" && (error as { code?: string }).code === "23505"; }

async function assertPostgresRunTaskRef(
  pool: PostgresQueryExecutor,
  runId: string,
  taskId: string
): Promise<void> {
  const result = await pool.query<{ id: string; task_id: string }>(
    `SELECT id, task_id FROM hatch_creator_distillation_runs WHERE id = $1`,
    [runId]
  );
  // Source intake events are allowed before a Run exists and use the Task id
  // as their temporary run_id. Once a Run exists, a mismatched Task is never
  // allowed to enter the graph.
  if (result.rows[0] && result.rows[0].task_id !== taskId) {
    throw new Error(`Graph record ${runId} belongs to another Task`);
  }
}

async function assertPostgresRevisionRef(
  pool: PostgresQueryExecutor,
  taskId: string,
  runId: string,
  revisionId: string,
  label: string
): Promise<void> {
  const result = await pool.query<{ id: string; run_id: string; task_id: string }>(
    `SELECT id, run_id, task_id FROM hatch_creator_distillation_revisions WHERE id = $1`,
    [revisionId]
  );
  if (!result.rows[0] || result.rows[0].run_id !== runId || result.rows[0].task_id !== taskId) {
    throw new Error(`${label} references an invalid RunRevision ${revisionId}`);
  }
}

async function assertPostgresArtifactRefs(
  pool: PostgresQueryExecutor,
  taskId: string,
  revisionId: string | undefined,
  artifactIds: string[]
): Promise<void> {
  const ids = [...new Set(artifactIds)];
  if (ids.length === 0) return;
  const result = await pool.query<{ artifact_id: string; task_id: string; revision_id: string | null }>(`
    SELECT artifact_id, task_id, revision_id
    FROM hatch_creator_distillation_artifacts
    WHERE artifact_id = ANY($1::text[])
  `, [ids]);
  if (result.rows.length !== ids.length) throw new Error("Artifact reference is unknown");
  for (const row of result.rows) {
    if (row.task_id !== taskId) throw new Error(`Artifact ${row.artifact_id} belongs to another Task`);
    if (revisionId && row.revision_id && row.revision_id !== revisionId) {
      throw new Error(`Artifact ${row.artifact_id} belongs to another RunRevision`);
    }
  }
}
