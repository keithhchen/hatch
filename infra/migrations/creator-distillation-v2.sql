-- Creator Distillation v2 control-plane schema.
-- Safe to re-run: all objects are created idempotently and no data is deleted.

CREATE TABLE IF NOT EXISTS hatch_creator_distillation_tasks (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  name TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')) DEFAULT 'active',
  product_id TEXT,
  run_id TEXT,
  latest_revision_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS hatch_creator_distillation_tasks_creator_idx
  ON hatch_creator_distillation_tasks (creator_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS hatch_creator_factory_runs (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  input_jsonb JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_for_creator', 'ready', 'needs_attention')),
  factory_stage TEXT,
  state_summary JSONB,
  pending_answers JSONB,
  answer_submissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  version BIGINT NOT NULL DEFAULT 1,
  next_attempt_at TIMESTAMPTZ,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (creator_id, idempotency_key)
);
ALTER TABLE hatch_creator_factory_runs
  ADD COLUMN IF NOT EXISTS input_digest TEXT;
ALTER TABLE hatch_creator_factory_runs
  ADD COLUMN IF NOT EXISTS answer_submissions JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE hatch_creator_distillation_tasks
  ADD COLUMN IF NOT EXISTS latest_revision_id TEXT;
ALTER TABLE hatch_creator_distillation_tasks
  ADD COLUMN IF NOT EXISTS product_id TEXT;
CREATE INDEX IF NOT EXISTS hatch_creator_factory_claim_idx
  ON hatch_creator_factory_runs (next_attempt_at, created_at, id)
  WHERE status IN ('queued', 'running');

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
