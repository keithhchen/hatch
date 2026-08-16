import assert from "node:assert/strict";
import { test } from "node:test";
import type { PostgresQueryExecutor } from "./postgresStore.js";
import {
  CreatorFactoryRepositoryError,
  InMemoryCreatorFactoryRepository,
  POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA,
  PostgresCreatorFactoryRepository,
  type FactoryRunRecord
} from "./creatorLearning/repository.js";
import { deriveQuestionBatchId } from "./creatorLearning/questionBatch.js";
import type { FactoryRunState, FactoryStartInput } from "./creatorLearning/types.js";

const QUESTION_ARTIFACT_SHA = `sha256:${"a".repeat(64)}`;
const BATCH_NONCE_1 = "1".repeat(64);
const BATCH_NONCE_2 = "2".repeat(64);
const BATCH_NONCE_3 = "3".repeat(64);
const BATCH_ID_1 = deriveQuestionBatchId("factory_1", QUESTION_ARTIFACT_SHA, BATCH_NONCE_1);
const BATCH_ID_2 = deriveQuestionBatchId("factory_1", QUESTION_ARTIFACT_SHA, BATCH_NONCE_2);
const BATCH_ID_3 = deriveQuestionBatchId("factory_1", QUESTION_ARTIFACT_SHA, BATCH_NONCE_3);

function factoryInput(creatorId = "11111111-1111-4111-8111-111111111111", runId = "factory_1"): FactoryStartInput {
  return {
    runId,
    creator: { id: creatorId, name: "Creator A" },
    productName: "Publish-ready launch post",
    productPromise: "Turn a product insight into a post that can be published directly.",
    sources: [{
      id: "source_1",
      authority: "creator_current",
      title: "Creator demonstration",
      content: "Choose one sharp claim and support it with a concrete example."
    }]
  };
}

function state(
  stage: FactoryRunState["stage"],
  runId = "factory_1",
  questionBatchNonce = BATCH_NONCE_1
): FactoryRunState {
  const timestamp = "2026-08-12T00:00:00.000Z";
  return {
    contractVersion: "1",
    runId,
    creator: { id: "11111111-1111-4111-8111-111111111111", name: "Creator A" },
    agentId: "launch-post",
    product: { id: "launch-post", name: "Publish-ready launch post" },
    productName: "Publish-ready launch post",
    stage,
    config: { developmentQuestions: 2, heldoutQuestions: 1, maxCorpusRevisions: 2 },
    artifacts: {
      productPromise: { path: "artifacts/input/product.md", sha256: "sha256:product", createdAt: timestamp },
      sourcePacket: { path: "artifacts/input/sources.md", sha256: "sha256:sources", createdAt: timestamp },
      ...(stage === "awaiting_creator_answers" ? {
        currentQuestionBatch: {
          path: "sealed/questions.md",
          sha256: QUESTION_ARTIFACT_SHA,
          createdAt: timestamp,
          sealed: true as const,
          batchNonce: questionBatchNonce,
          batchId: deriveQuestionBatchId(runId, QUESTION_ARTIFACT_SHA, questionBatchNonce)
        }
      } : {}),
      corpusCandidates: [],
      evaluationRounds: [],
      heldoutRounds: []
    },
    ...(stage === "awaiting_creator_answers"
      ? { pendingQuestionBatch: { purpose: "initial" as const, count: 3 } }
      : {}),
    replacementHeldoutNeeded: 0,
    corpusRevisionCount: 0,
    developmentEvaluated: false,
    ...(stage === "needs_attention" ? { lastError: "Creator input is contradictory" } : {}),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

test("Creator Factory schema persists scheduling, ownership, state summary, and pending answers", () => {
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /creator_id TEXT NOT NULL/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /input_digest TEXT NOT NULL/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /input_jsonb JSONB NOT NULL/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /state_summary JSONB/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /pending_answers JSONB/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /answer_submissions JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /ADD COLUMN IF NOT EXISTS input_digest TEXT/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /next_attempt_at TIMESTAMPTZ/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /lease_owner TEXT/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /lease_token TEXT/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /lease_expires_at TIMESTAMPTZ/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /attempts INTEGER NOT NULL DEFAULT 0/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /last_error TEXT/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /UNIQUE \(creator_id, idempotency_key\)/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /INSERT INTO hatch_creator_products/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /FROM hatch_creator_distillation_tasks AS legacy/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /legacy\.deleted_at IS NOT NULL OR legacy\.status = 'deleted'/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /SET promise = COALESCE\(NULLIF\(promise, ''\), NULLIF\(brief, ''\), NULLIF\(name, ''\)\)/);
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /ALTER TABLE hatch_creator_products ALTER COLUMN promise SET NOT NULL/);
  assert.ok(
    POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA.indexOf("ALTER TABLE hatch_creator_products ADD COLUMN IF NOT EXISTS promise TEXT;")
      < POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA.indexOf("INSERT INTO hatch_creator_products")
  );
  assert.match(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, /ON CONFLICT \(id\) DO NOTHING/);
});

test("In-memory repository scopes reads to the Creator and creates idempotently", async () => {
  const repository = new InMemoryCreatorFactoryRepository();
  const first = await repository.create({
    id: "factory_1",
    creatorId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "request_1",
    input: factoryInput()
  });
  const replay = await repository.create({
    id: "factory_transport_retry",
    creatorId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "request_1",
    input: factoryInput("11111111-1111-4111-8111-111111111111", "factory_transport_retry")
  });

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.run.id, "factory_1");
  assert.equal(replay.run.input.runId, "factory_1");
  assert.equal((await repository.getForCreator("11111111-1111-4111-8111-111111111111", "factory_1"))?.id, "factory_1");
  assert.equal(await repository.getForCreator("22222222-2222-4222-8222-222222222222", "factory_1"), undefined);

  await assert.rejects(
    () => repository.create({
      id: "factory_conflicting_retry",
      creatorId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "request_1",
      input: { ...factoryInput("11111111-1111-4111-8111-111111111111", "factory_conflicting_retry"), productPromise: "A different request payload." }
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "idempotency_conflict"
  );

  await assert.rejects(
    () => repository.create({
      id: "factory_mismatch",
      creatorId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "request_2",
      input: factoryInput("11111111-1111-4111-8111-111111111111", "factory_mismatch")
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "creator_mismatch"
  );
  await assert.rejects(
    () => repository.create({
      id: "factory_1",
      creatorId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "request_3",
      input: factoryInput("22222222-2222-4222-8222-222222222222", "factory_1")
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "run_id_conflict"
  );
});

test("In-memory queue fences leases and moves Creator answers back to queued work", async () => {
  const repository = new InMemoryCreatorFactoryRepository();
  await repository.create({
    id: "factory_1",
    creatorId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "request_1",
    input: factoryInput(),
    nextAttemptAt: "2026-08-12T00:00:00.000Z"
  });
  const firstLease = await repository.claim({
    workerId: "worker_a",
    leaseMs: 60_000,
    now: "2026-08-12T00:00:01.000Z"
  });
  assert.ok(firstLease?.leaseToken);
  const firstLeaseToken = firstLease.leaseToken;
  assert.equal(firstLease.status, "running");
  assert.equal(firstLease.attempts, 1);
  await repository.assertLease({
    runId: "factory_1",
    workerId: "worker_a",
    leaseToken: firstLeaseToken,
    now: "2026-08-12T00:00:01.500Z"
  });
  assert.equal((await repository.getForCreator("11111111-1111-4111-8111-111111111111", "factory_1"))?.version, firstLease.version);
  await assert.rejects(
    () => repository.assertLease({
      runId: "factory_1",
      workerId: "worker_b",
      leaseToken: firstLeaseToken,
      now: "2026-08-12T00:00:01.500Z"
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "lease_lost"
  );

  await assert.rejects(
    () => repository.heartbeat({
      runId: "factory_1",
      workerId: "worker_a",
      leaseToken: "stale-token",
      now: "2026-08-12T00:00:02.000Z"
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "lease_lost"
  );
  const waiting = await repository.complete({
    runId: "factory_1",
    workerId: "worker_a",
    leaseToken: firstLeaseToken,
    state: state("awaiting_creator_answers"),
    now: "2026-08-12T00:00:02.000Z"
  });
  assert.equal(waiting.status, "waiting_for_creator");
  assert.equal(waiting.factoryStage, "awaiting_creator_answers");
  assert.equal(waiting.leaseToken, undefined);

  await assert.rejects(
    () => repository.submitAnswers({
      creatorId: "11111111-1111-4111-8111-111111111111",
      runId: "factory_1",
      answers: {}
    }),
    /must contain answerMarkdown or structured answers/
  );

  await assert.rejects(
    () => repository.submitAnswers({
      creatorId: "22222222-2222-4222-8222-222222222222",
      runId: "factory_1",
      answers: { answerMarkdown: "## Q1\nAnswer" }
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "run_not_found"
  );
  await assert.rejects(
    () => repository.submitAnswers({
      creatorId: "11111111-1111-4111-8111-111111111111",
      runId: "factory_1",
      answers: { answerMarkdown: "## Q1\nAnswer" }
    }),
    /questionBatchId must not be empty/
  );
  await assert.rejects(
    () => repository.submitAnswers({
      creatorId: "11111111-1111-4111-8111-111111111111",
      runId: "factory_1",
      answers: {
        answerMarkdown: "## Q1\nAnswer",
        questionBatchId: BATCH_ID_2
      }
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "version_conflict"
  );
  await assert.rejects(
    () => repository.submitAnswers({
      creatorId: "11111111-1111-4111-8111-111111111111",
      runId: "factory_1",
      expectedVersion: waiting.version - 1,
      answers: { answerMarkdown: "## Q1\nAnswer", questionBatchId: BATCH_ID_1 }
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "version_conflict"
  );
  const queued = await repository.submitAnswers({
    creatorId: "11111111-1111-4111-8111-111111111111",
    runId: "factory_1",
    expectedVersion: waiting.version,
    answers: {
      answerMarkdown: "## Q1\nAnswer",
      submissionId: "answers_1",
      questionBatchId: BATCH_ID_1
    },
    now: "2026-08-12T00:00:03.000Z"
  });
  assert.equal(queued.status, "queued");
  assert.equal(queued.pendingAnswers?.submissionId, "answers_1");
  assert.equal(queued.pendingAnswers?.questionBatchId, BATCH_ID_1);

  const queuedReplay = await repository.submitAnswers({
    creatorId: "11111111-1111-4111-8111-111111111111",
    runId: "factory_1",
    expectedVersion: waiting.version,
    answers: {
      answerMarkdown: "## Q1\nAnswer",
      submissionId: "answers_1",
      questionBatchId: BATCH_ID_1
    },
    now: "2026-08-12T00:00:03.500Z"
  });
  assert.equal(queuedReplay.status, "queued");
  assert.equal(queuedReplay.version, queued.version);

  await assert.rejects(
    () => repository.submitAnswers({
      creatorId: "11111111-1111-4111-8111-111111111111",
      runId: "factory_1",
      answers: {
        answerMarkdown: "## Q1\nChanged answer",
        submissionId: "answers_1",
        questionBatchId: BATCH_ID_1
      }
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "idempotency_conflict"
  );

  const secondLease = await repository.claim({
    workerId: "worker_b",
    leaseMs: 60_000,
    now: "2026-08-12T00:00:04.000Z"
  });
  assert.ok(secondLease?.leaseToken);
  assert.equal(secondLease.attempts, 2);
  const runningReplay = await repository.submitAnswers({
    creatorId: "11111111-1111-4111-8111-111111111111",
    runId: "factory_1",
    answers: {
      answerMarkdown: "## Q1\nAnswer",
      submissionId: "answers_1",
      questionBatchId: BATCH_ID_1
    }
  });
  assert.equal(runningReplay.status, "running");
  assert.equal(runningReplay.version, secondLease.version);

  const laterWaiting = await repository.complete({
    runId: "factory_1",
    workerId: "worker_b",
    leaseToken: secondLease.leaseToken,
    state: state("awaiting_creator_answers", "factory_1", BATCH_NONCE_2),
    now: "2026-08-12T00:00:05.000Z"
  });
  const laterWaitingReplay = await repository.submitAnswers({
    creatorId: "11111111-1111-4111-8111-111111111111",
    runId: "factory_1",
    answers: {
      answerMarkdown: "## Q1\nAnswer",
      submissionId: "answers_1",
      questionBatchId: BATCH_ID_1
    }
  });
  assert.equal(laterWaitingReplay.status, "waiting_for_creator");
  assert.equal(laterWaitingReplay.version, laterWaiting.version);

  await assert.rejects(
    () => repository.submitAnswers({
      creatorId: "11111111-1111-4111-8111-111111111111",
      runId: "factory_1",
      answers: {
        answers: [{ questionId: "Q1", answer: "Late answer for the old batch" }],
        submissionId: "unseen_stale_submission",
        questionBatchId: BATCH_ID_1
      }
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "version_conflict"
  );

  const structuredAnswers = [{ questionId: "H1", answer: "Replacement answer" }];
  const laterQueued = await repository.submitAnswers({
    creatorId: "11111111-1111-4111-8111-111111111111",
    runId: "factory_1",
    expectedVersion: laterWaiting.version,
    answers: {
      answers: structuredAnswers,
      submissionId: "answers_2",
      questionBatchId: BATCH_ID_2
    },
    now: "2026-08-12T00:00:06.000Z"
  });
  structuredAnswers[0]!.answer = "mutated by caller";
  assert.equal(laterQueued.pendingAnswers?.submissionId, "answers_2");
  assert.deepEqual(laterQueued.pendingAnswers?.answers, [{ questionId: "H1", answer: "Replacement answer" }]);
  const thirdLease = await repository.claim({
    workerId: "worker_c",
    leaseMs: 60_000,
    now: "2026-08-12T00:00:07.000Z"
  });
  assert.ok(thirdLease?.leaseToken);
  const ready = await repository.complete({
    runId: "factory_1",
    workerId: "worker_c",
    leaseToken: thirdLease.leaseToken,
    state: state("ready"),
    now: "2026-08-12T00:00:08.000Z"
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.pendingAnswers, undefined);

  await assert.rejects(
    () => repository.fail({
      runId: "factory_1",
      workerId: "worker_a",
      leaseToken: firstLeaseToken,
      error: "late failure",
      now: "2026-08-12T00:00:09.000Z"
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "lease_lost"
  );
});

test("expired work can be reclaimed, while failure keeps it durably retryable", async () => {
  const repository = new InMemoryCreatorFactoryRepository();
  await repository.create({
    id: "factory_1",
    creatorId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "request_1",
    input: factoryInput(),
    nextAttemptAt: "2026-08-12T00:00:00.000Z"
  });
  const abandoned = await repository.claim({
    workerId: "worker_a",
    leaseMs: 1_000,
    now: "2026-08-12T00:00:01.000Z"
  });
  assert.ok(abandoned);
  const reclaimed = await repository.claim({
    workerId: "worker_b",
    leaseMs: 10_000,
    now: "2026-08-12T00:00:03.000Z"
  });
  assert.ok(reclaimed?.leaseToken);
  assert.equal(reclaimed.leaseOwner, "worker_b");
  assert.equal(reclaimed.attempts, 2);
  const failed = await repository.fail({
    runId: reclaimed.id,
    workerId: "worker_b",
    leaseToken: reclaimed.leaseToken,
    error: "temporary provider failure",
    retryDelayMs: 296_000,
    now: "2026-08-12T00:00:04.000Z"
  });
  assert.equal(failed.status, "queued");
  assert.equal(failed.lastError, "temporary provider failure");
  assert.equal(await repository.claim({ workerId: "early", now: "2026-08-12T00:04:59.000Z" }), undefined);
  assert.equal((await repository.claim({ workerId: "retry", now: "2026-08-12T00:05:00.000Z" }))?.attempts, 3);
});

test("Postgres create binds an idempotency key to the canonical semantic input", async () => {
  const database = new StatefulFactoryPostgres();
  const repository = new PostgresCreatorFactoryRepository(database);
  const first = await repository.create({
    id: "factory_1",
    creatorId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "request_1",
    input: factoryInput()
  });
  const replay = await repository.create({
    id: "factory_transport_retry",
    creatorId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "request_1",
    input: factoryInput("11111111-1111-4111-8111-111111111111", "factory_transport_retry")
  });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.run.id, "factory_1");

  await assert.rejects(
    () => repository.create({
      id: "factory_changed",
      creatorId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "request_1",
      input: { ...factoryInput("11111111-1111-4111-8111-111111111111", "factory_changed"), productName: "Changed product" }
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "idempotency_conflict"
  );
  const insert = database.queries.find((query) => /INSERT INTO hatch_creator_factory_runs/.test(query.text));
  assert.ok(insert);
  assert.match(String(insert.values?.[3]), /^sha256:[0-9a-f]{64}$/);
  assert.match(insert.text, /input_digest/);
});

test("Postgres answer submission receipts survive status changes and fence conflicting reuse", async () => {
  const database = new StatefulFactoryPostgres(databaseRow({
    status: "waiting_for_creator",
    factory_stage: "awaiting_creator_answers",
    state_summary: state("awaiting_creator_answers")
  }));
  const repository = new PostgresCreatorFactoryRepository(database);
  const submitted = await repository.submitAnswers({
    creatorId: "11111111-1111-4111-8111-111111111111",
    runId: "factory_1",
    expectedVersion: 1,
    answers: {
      answerMarkdown: "## Q1\nAnswer",
      submissionId: "submission_1",
      questionBatchId: BATCH_ID_1
    },
    now: "2026-08-12T00:01:00.000Z"
  });
  assert.equal(submitted.status, "queued");
  const replay = await repository.submitAnswers({
    creatorId: "11111111-1111-4111-8111-111111111111",
    runId: "factory_1",
    expectedVersion: 1,
    answers: {
      answerMarkdown: "## Q1\nAnswer",
      submissionId: "submission_1",
      questionBatchId: BATCH_ID_1
    },
    now: "2026-08-12T00:02:00.000Z"
  });
  assert.equal(replay.status, "queued");
  assert.equal(replay.version, submitted.version);

  await assert.rejects(
    () => repository.submitAnswers({
      creatorId: "11111111-1111-4111-8111-111111111111",
      runId: "factory_1",
      answers: {
        answerMarkdown: "## Q1\nAnswer",
        submissionId: "submission_1",
        questionBatchId: BATCH_ID_3
      }
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "idempotency_conflict"
  );
  const submissionUpdate = database.queries.find((query) => /answer_submissions = CASE/.test(query.text));
  assert.ok(submissionUpdate);
  assert.match(submissionUpdate.text, /NOT \(answer_submissions \? \$6::text\)/);
  assert.match(submissionUpdate.text, /currentQuestionBatch,batchId.*= \$9::text/s);

  const staleDatabase = new StatefulFactoryPostgres(databaseRow({
    status: "waiting_for_creator",
    factory_stage: "awaiting_creator_answers",
    state_summary: state("awaiting_creator_answers", "factory_1", BATCH_NONCE_2)
  }));
  const staleRepository = new PostgresCreatorFactoryRepository(staleDatabase);
  await assert.rejects(
    () => staleRepository.submitAnswers({
      creatorId: "11111111-1111-4111-8111-111111111111",
      runId: "factory_1",
      answers: {
        answers: [{ questionId: "Q1", answer: "Old batch answer" }],
        submissionId: "new_but_stale",
        questionBatchId: BATCH_ID_1
      }
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "version_conflict"
  );
});

test("Postgres claim is one atomic SKIP LOCKED statement and every lease mutation is fenced", async () => {
  const database = new CapturingFactoryPostgres();
  const repository = new PostgresCreatorFactoryRepository(database);
  const claimed = await repository.claim({
    workerId: "worker_a",
    leaseMs: 60_000,
    now: "2026-08-12T00:00:00.000Z"
  });
  assert.ok(claimed?.leaseToken);
  await repository.assertLease({
    runId: claimed.id,
    workerId: "worker_a",
    leaseToken: claimed.leaseToken,
    now: "2026-08-12T00:00:00.500Z"
  });
  await repository.heartbeat({
    runId: claimed.id,
    workerId: "worker_a",
    leaseToken: claimed.leaseToken,
    leaseMs: 60_000,
    now: "2026-08-12T00:00:01.000Z"
  });
  await repository.complete({
    runId: claimed.id,
    workerId: "worker_a",
    leaseToken: claimed.leaseToken,
    state: state("ready"),
    now: "2026-08-12T00:00:02.000Z"
  });

  const claimQuery = database.queries.find((query) => /claimable AS/.test(query.text));
  assert.ok(claimQuery);
  assert.match(claimQuery.text, /COALESCE\(\$1::timestamptz, clock_timestamp\(\)\)/);
  assert.match(claimQuery.text, /FOR UPDATE OF run SKIP LOCKED/);
  assert.match(claimQuery.text, /UPDATE hatch_creator_factory_runs AS run/);
  assert.match(claimQuery.text, /run\.status = 'running' AND run\.lease_expires_at <= timing\.now_at/);

  const leaseAssertion = database.queries.find((query) => /SELECT run\.\*/.test(query.text) && /lease_expires_at > timing\.now_at/.test(query.text));
  assert.ok(leaseAssertion);
  assert.match(leaseAssertion.text, /COALESCE\(\$4::timestamptz, clock_timestamp\(\)\)/);
  assert.doesNotMatch(leaseAssertion.text, /UPDATE hatch_creator_factory_runs/);

  const fencedMutations = database.queries.filter((query) => (
    /SET lease_expires_at = timing\.now_at/.test(query.text) || /SET status = \$4/.test(query.text)
  ));
  assert.equal(fencedMutations.length, 2);
  for (const query of fencedMutations) {
    assert.match(query.text, /lease_owner = \$2/);
    assert.match(query.text, /lease_token = \$3/);
    assert.match(query.text, /lease_expires_at > timing\.now_at/);
    assert.match(query.text, /clock_timestamp\(\)/);
  }
});

test("Postgres production lease timing is derived from clock_timestamp, including fail", async () => {
  const database = new CapturingFactoryPostgres();
  const repository = new PostgresCreatorFactoryRepository(database);
  const claimed = await repository.claim({ workerId: "worker_prod", leaseMs: 30_000 });
  assert.ok(claimed?.leaseToken);
  await repository.fail({
    runId: claimed.id,
    workerId: "worker_prod",
    leaseToken: claimed.leaseToken,
    error: "retryable",
    retryDelayMs: 30_000
  });

  const claimQuery = database.queries.find((query) => /claimable AS/.test(query.text));
  const failQuery = database.queries.find((query) => /SET status = 'queued'/.test(query.text));
  assert.ok(claimQuery);
  assert.ok(failQuery);
  assert.equal(claimQuery.values?.[0], null);
  assert.equal(failQuery.values?.[5], null);
  assert.equal(failQuery.values?.[6], 30_000);
  assert.match(failQuery.text, /COALESCE\(\$6::timestamptz, clock_timestamp\(\)\)/);
  assert.match(failQuery.text, /lease_expires_at > timing\.now_at/);
  assert.match(failQuery.text, /timing\.now_at \+ \(\$7::bigint \* interval '1 millisecond'\)/);
});

type Row = Record<string, unknown>;

class StatefulFactoryPostgres implements PostgresQueryExecutor {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];

  constructor(private row?: Row) {}

  async query<T extends Row = Row>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ text, values });
    if (/CREATE TABLE IF NOT EXISTS hatch_creator_factory_runs/.test(text)) return { rows: [] };
    if (/SELECT \* FROM hatch_creator_factory_runs WHERE creator_id = \$1 AND idempotency_key = \$2/.test(text)) {
      const matches = this.row?.creator_id === values?.[0] && this.row?.idempotency_key === values?.[1];
      return this.rows(matches && this.row ? [this.row] : []);
    }
    if (/INSERT INTO hatch_creator_factory_runs/.test(text)) {
      this.row = databaseRow({
        id: values?.[0],
        creator_id: values?.[1],
        idempotency_key: values?.[2],
        input_digest: values?.[3],
        input_jsonb: JSON.parse(String(values?.[4])),
        next_attempt_at: values?.[5] ?? "2026-08-12T00:00:00.000Z"
      });
      return this.rows([this.row]);
    }
    if (/answer_submissions = CASE/.test(text) && this.row) {
      const versionMatches = values?.[4] === null || Number(values?.[4]) === Number(this.row.version);
      const history = this.row.answer_submissions as Record<string, unknown>;
      const submissionId = typeof values?.[5] === "string" ? values[5] : undefined;
      const stateSummary = this.row.state_summary as FactoryRunState | undefined;
      const batchMatches = typeof values?.[8] === "string"
        && stateSummary?.artifacts.currentQuestionBatch?.batchId === values[8];
      if (this.row.status !== "waiting_for_creator" || !versionMatches || !batchMatches || (submissionId && history[submissionId])) {
        return { rows: [] };
      }
      if (submissionId) {
        history[submissionId] = {
          answerDigest: values?.[6],
          questionBatchId: values?.[8] ?? "unknown",
          submittedAt: JSON.parse(String(values?.[2])).submittedAt
        };
      }
      this.row.pending_answers = JSON.parse(String(values?.[2]));
      this.row.status = "queued";
      this.row.next_attempt_at = values?.[3] ?? "2026-08-12T00:00:00.000Z";
      this.row.version = Number(this.row.version) + 1;
      this.row.updated_at = values?.[3] ?? "2026-08-12T00:00:00.000Z";
      return this.rows([this.row]);
    }
    if (/SELECT \* FROM hatch_creator_factory_runs WHERE id = \$1 AND creator_id = \$2/.test(text)) {
      const matches = this.row?.id === values?.[0] && this.row?.creator_id === values?.[1];
      return this.rows(matches && this.row ? [this.row] : []);
    }
    return { rows: [] };
  }

  private rows<T extends Row>(rows: Row[]): { rows: T[] } {
    return { rows: rows.map((row) => structuredClone(row)) as T[] };
  }
}

class CapturingFactoryPostgres implements PostgresQueryExecutor {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];
  private row: Row | undefined;

  async query<T extends Row = Row>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ text, values });
    if (/^\s*CREATE TABLE/i.test(text)) return { rows: [] };
    if (/claimable AS/.test(text)) {
      const timestamp = String(values?.[0] ?? "2026-08-12T00:00:00.000Z");
      const leaseExpiresAt = new Date(new Date(timestamp).getTime() + Number(values?.[3])).toISOString();
      this.row = databaseRow({
        status: "running",
        lease_owner: values?.[1],
        lease_token: values?.[2],
        lease_expires_at: leaseExpiresAt,
        attempts: 1,
        version: 2,
        updated_at: timestamp
      });
      return this.rows([this.row]);
    }
    if (/SELECT run\.\*/.test(text) && /lease_expires_at > timing\.now_at/.test(text) && this.row) {
      const matches = this.row.lease_owner === values?.[1]
        && this.row.lease_token === values?.[2]
        && Date.parse(String(this.row.lease_expires_at)) > Date.parse(String(values?.[3]));
      return this.rows(matches ? [this.row] : []);
    }
    if (/SET lease_expires_at = timing\.now_at/.test(text) && this.row) {
      const timestamp = String(values?.[4] ?? "2026-08-12T00:00:00.000Z");
      this.row.lease_expires_at = new Date(new Date(timestamp).getTime() + Number(values?.[3])).toISOString();
      this.row.updated_at = timestamp;
      this.row.version = Number(this.row.version) + 1;
      return this.rows([this.row]);
    }
    if (/SET status = \$4/.test(text) && this.row) {
      this.row.status = values?.[3];
      this.row.factory_stage = values?.[4];
      this.row.state_summary = values?.[5];
      this.row.pending_answers = null;
      this.row.lease_owner = null;
      this.row.lease_token = null;
      this.row.lease_expires_at = null;
      this.row.next_attempt_at = null;
      this.row.updated_at = values?.[7] ?? "2026-08-12T00:00:00.000Z";
      this.row.version = Number(this.row.version) + 1;
      return this.rows([this.row]);
    }
    if (/SET status = 'queued'/.test(text) && /lease_owner = \$2/.test(text) && this.row) {
      const timestamp = String(values?.[5] ?? "2026-08-12T00:00:00.000Z");
      this.row.status = "queued";
      this.row.next_attempt_at = values?.[6] === null || values?.[6] === undefined
        ? values?.[3] ?? timestamp
        : new Date(new Date(timestamp).getTime() + Number(values[6])).toISOString();
      this.row.lease_owner = null;
      this.row.lease_token = null;
      this.row.lease_expires_at = null;
      this.row.last_error = values?.[4];
      this.row.updated_at = timestamp;
      this.row.version = Number(this.row.version) + 1;
      return this.rows([this.row]);
    }
    return { rows: [] };
  }

  private rows<T extends Row>(rows: Row[]): { rows: T[] } {
    return { rows: rows.map((row) => ({ ...row })) as T[] };
  }
}

function databaseRow(overrides: Row = {}): Row {
  return {
    id: "factory_1",
    creator_id: "11111111-1111-4111-8111-111111111111",
    idempotency_key: "request_1",
    input_digest: "sha256:test-input",
    input_jsonb: factoryInput(),
    status: "queued",
    factory_stage: null,
    state_summary: null,
    pending_answers: null,
    answer_submissions: {},
    version: 1,
    next_attempt_at: "2026-08-12T00:00:00.000Z",
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    attempts: 0,
    last_error: null,
    created_at: "2026-08-12T00:00:00.000Z",
    updated_at: "2026-08-12T00:00:00.000Z",
    ...overrides
  };
}

// Compile-time guard: API-facing repository records remain serializable DTOs.
const _factoryRunRecord: FactoryRunRecord | undefined = undefined;
void _factoryRunRecord;
