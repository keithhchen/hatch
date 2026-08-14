import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { FactoryFileStore } from "./fileStore.js";
import { CreatorSourceLibrary, CreatorSourceLibraryError } from "./sourceLibrary.js";
import type { ArtifactObjectStore } from "./objectStore.js";
import type { DistillationGraphStore, DistillationRelease } from "./distillationGraph.js";
import { isDistillationTaskRepository, validateTaskText, type DistillationTaskRecord } from "./tasks.js";
import { parseQuestions } from "./markdown.js";
import { requireQuestionBatchId } from "./questionBatch.js";
import {
  CreatorFactoryRepositoryError,
  type CreatorFactoryRepository,
  type FactoryRunRecord
} from "./repository.js";
import type { ArtifactRef, CreatorQuestion, FactoryAgentProduct, FactoryAgentTool, FactoryStartInput } from "./types.js";

export type CreateFactoryRunRequest = {
  taskId?: string;
  agentId?: string;
  product?: Partial<FactoryAgentProduct>;
  tools?: FactoryAgentTool[];
  taskName: string;
  taskBrief: string;
  sources?: FactoryStartInput["sources"];
  sourceDocumentIds?: string[];
  sourceSnapshotId?: string;
  config?: FactoryStartInput["config"];
};

export type SubmitFactoryAnswersRequest = {
  answers: Array<{ questionId: string; answer: string }>;
  expectedVersion?: number;
  submissionId?: string;
  questionBatchId: string;
};

export class CreatorFactoryInputTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreatorFactoryInputTooLargeError";
  }
}

export type CreatorFactoryRunView = {
  id: string;
  taskId?: string;
  distillationRunId?: string;
  revisionId?: string;
  revisionNumber?: number;
  parentRevisionId?: string;
  sourceSnapshotId?: string;
  derivedStatus?: string;
  qualityGates?: Array<{ name: string; critical: boolean; status: string; reason?: string }>;
  agentId?: string;
  product?: FactoryAgentProduct;
  declaredToolIds?: string[];
  taskName: string;
  status: FactoryRunRecord["status"];
  stage?: FactoryRunRecord["factoryStage"];
  version: number;
  pendingQuestions: Array<{ id: string; question: string }>;
  questionBatchId?: string;
  candidate?: {
    version: number;
    reason: string;
    systemDigest: string;
    corpusDigest?: string;
    corpusVerified: boolean;
    reportDigest?: string;
    regressionDigest?: string;
    heldOutDigest?: string;
    heldOutSampleCount?: number;
    failedCriticalCases?: number;
    builtAt?: string;
    factoryVersion: "creator-factory-contract-1";
  };
  retryable: boolean;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type PublishableFactoryCorpus = {
  runId: string;
  agentId: string;
  product: FactoryAgentProduct;
  corpusDigest: string;
  corpusRoot: string;
};

export class CreatorFactoryService {
  private readonly sourceLibrary: CreatorSourceLibrary;

  constructor(
    private readonly repository: CreatorFactoryRepository,
    private readonly factoryRoot: string,
    sourceLibrary?: CreatorSourceLibrary,
    private readonly objectStore?: ArtifactObjectStore,
    private readonly graphStore?: DistillationGraphStore
  ) {
    this.sourceLibrary = sourceLibrary ?? new CreatorSourceLibrary(path.join(factoryRoot, "source-library"), objectStore, graphStore);
  }

  async createSourceDocument(creatorId: string, input: Parameters<CreatorSourceLibrary["createFromUpload"]>[1]) {
    const taskId = requireText(input.taskId, "taskId");
    await this.requireActiveTask(creatorId, taskId);
    await this.sourceLibrary.initialize();
    return this.sourceLibrary.createFromUpload(creatorId, input);
  }

  async listSourceDocuments(creatorId: string, taskId?: string) {
    if (taskId) await this.requireActiveTask(creatorId, taskId);
    await this.sourceLibrary.initialize();
    return this.sourceLibrary.listDocuments(creatorId, taskId);
  }

  async getSourceDocument(creatorId: string, documentId: string) {
    await this.sourceLibrary.initialize();
    return this.sourceLibrary.getDocument(creatorId, documentId);
  }

  async createSourceSnapshot(creatorId: string, input: { documentIds: string[]; taskId?: string }) {
    const taskId = requireText(input.taskId, "taskId");
    await this.requireActiveTask(creatorId, taskId);
    await this.sourceLibrary.initialize();
    return this.sourceLibrary.createSnapshot(creatorId, input);
  }

  async getSourceSnapshot(creatorId: string, snapshotId: string) {
    await this.sourceLibrary.initialize();
    return this.sourceLibrary.getSnapshot(creatorId, snapshotId);
  }

  async createTask(creatorId: string, input: { name: string; brief: string }): Promise<DistillationTaskRecord> {
    const repository = this.taskRepository();
    const task = await repository.createTask({
      id: `task_${randomUUID().replaceAll("-", "")}`,
      creatorId: requireText(creatorId, "creatorId"),
      name: validateTaskText(input.name, "task.name", 240),
      brief: validateTaskText(input.brief, "task.brief"),
      // A Task is the product boundary. Generate its Product identity once;
      // presentation/configuration remains outside this control-plane record.
      productId: randomUUID()
    });
    if (this.graphStore) {
      await this.graphStore.initialize();
      await this.graphStore.appendEvent({
        id: `evt_${randomUUID().replaceAll("-", "")}`,
        eventKey: `${task.id}:created`,
        taskId: task.id,
        runId: task.runId ?? task.id,
        type: "task_created",
        node: "intake",
        actor: "creator",
        parentEventIds: [],
        artifactIds: [],
        payload: { nameLength: task.name.length }
      });
    }
    return task;
  }

  async listTasks(creatorId: string): Promise<DistillationTaskRecord[]> {
    return this.taskRepository().listTasks(requireText(creatorId, "creatorId"));
  }

  async getTask(creatorId: string, taskId: string): Promise<DistillationTaskRecord> {
    const task = await this.taskRepository().getTask(requireText(creatorId, "creatorId"), requireText(taskId, "taskId"));
    if (!task) throw new CreatorFactoryRepositoryError("run_not_found", `Distillation Task ${taskId} was not found`);
    return task;
  }

  async deleteTask(creatorId: string, taskId: string): Promise<DistillationTaskRecord> {
    return this.taskRepository().softDeleteTask(requireText(creatorId, "creatorId"), requireText(taskId, "taskId"));
  }

  async getTaskGraph(creatorId: string, taskId: string) {
    const task = await this.getTask(creatorId, taskId);
    if (!this.graphStore) {
      return { taskId: task.id, status: "not_started" as const, nodeStatus: {}, gates: [], criticalGateFailures: [], correctionRequired: false };
    }
    await this.graphStore.initialize();
    return this.graphStore.derive(task.id);
  }

  async create(
    creator: { id: string; name: string },
    request: CreateFactoryRunRequest,
    idempotencyKey: string
  ): Promise<{ run: CreatorFactoryRunView; created: boolean }> {
    const normalized = validateCreateRequest(request);
    let task: DistillationTaskRecord | undefined;
    if (normalized.taskId) {
      task = await this.getTask(creator.id, normalized.taskId);
      if (task.status !== "active") throw new CreatorFactoryRepositoryError("invalid_status", `Distillation Task ${normalized.taskId} is deleted`);
    }
    const taskProductId = task ? (task.productId ?? deterministicTaskProductId(task.id)) : undefined;
    if (task && normalized.agentId && normalized.agentId !== taskProductId) {
      throw new CreatorFactoryRepositoryError("invalid_status", `Distillation Task ${task.id} is bound to another Product`);
    }
    if (task && normalized.product?.id && normalized.product.id !== taskProductId) {
      throw new CreatorFactoryRepositoryError("invalid_status", `Distillation Task ${task.id} is bound to another Product`);
    }
    const taskProduct = task
      ? {
          ...(normalized.product ?? {}),
          id: taskProductId!,
          name: normalized.product?.name ?? task.name,
          description: normalized.product?.description ?? task.brief
        }
      : normalized.product;
    const autoSnapshot = !normalized.sourceSnapshotId && normalized.sourceDocumentIds?.length
      ? await this.sourceLibrary.createSnapshot(creator.id, { documentIds: normalized.sourceDocumentIds, taskId: normalized.taskId })
      : undefined;
    const snapshotId = normalized.sourceSnapshotId ?? autoSnapshot?.id;
    // A Task revision is a graph revision, not an inline ad-hoc Factory run.
    // Enforce the immutable Source Snapshot boundary before creating the
    // repository record so an invalid request cannot leave an orphan run.
    if (task && !snapshotId) {
      throw new CreatorFactoryRepositoryError("invalid_status", "A Task revision must be pinned to a Source Snapshot");
    }
    if (task && snapshotId) {
      const snapshot = await this.sourceLibrary.getSnapshot(creator.id, snapshotId);
      if (snapshot.taskId !== task.id) {
        throw new CreatorFactoryRepositoryError("invalid_status", "Source Snapshot belongs to another Distillation Task");
      }
    }
    const sources = snapshotId
      ? await this.sourceLibrary.resolveSnapshotSources(creator.id, snapshotId)
      : normalized.sources ?? [];
    const runId = `factory_${randomUUID().replaceAll("-", "")}`;
    const distillationRunId = task?.runId ?? `distill_${randomUUID().replaceAll("-", "")}`;
    const revisionNumber = task?.latestRevisionId ? await this.nextRevisionNumber(creator.id, normalized.taskId!) : 1;
    const taskName = task?.name ?? normalized.taskName;
    const taskBrief = task?.brief ?? normalized.taskBrief;
    const input: FactoryStartInput = {
      runId,
      creator: { id: requireText(creator.id, "creator.id"), name: requireText(creator.name, "creator.name") },
      ...(normalized.taskId ? { taskId: normalized.taskId } : {}),
      ...(task ? {
        distillationRunId,
        revisionId: runId,
        revisionNumber,
        ...(task.latestRevisionId ? { parentRevisionId: task.latestRevisionId } : {})
      } : {}),
      ...((taskProductId ?? normalized.agentId) ? { agentId: taskProductId ?? normalized.agentId } : {}),
      ...(taskProduct ? { product: taskProduct } : {}),
      tools: normalized.tools,
      taskName,
      taskBrief,
      sources,
      ...(snapshotId ? { sourceSnapshotId: snapshotId } : {}),
      ...(normalized.config ? { config: normalized.config } : {})
    };
    const result = await this.repository.create({
      id: runId,
      creatorId: creator.id,
      idempotencyKey: requireText(idempotencyKey, "Idempotency-Key"),
      input
    });
    if (task) {
      await this.taskRepository().setTaskRevision(creator.id, task.id, { runId: distillationRunId, revisionId: runId, productId: taskProductId! });
      await this.graphStore?.initialize();
      await this.graphStore?.ensureRun({
        id: distillationRunId,
        taskId: task.id,
        creatorId: creator.id,
        productId: taskProductId,
        createdAt: result.run.createdAt
      });
      await this.graphStore?.createRevision({
        id: runId,
        runId: distillationRunId,
        taskId: task.id,
        revision: revisionNumber,
        sourceSnapshotId: snapshotId!,
        ...(task.latestRevisionId ? { parentRevisionId: task.latestRevisionId } : {}),
        createdAt: result.run.createdAt
      });
      await this.graphStore?.appendEvent({
        id: `evt_${randomUUID().replaceAll("-", "")}`,
        eventKey: `${runId}:revision_created`,
        taskId: task.id,
        runId: distillationRunId,
        revisionId: runId,
        type: "revision_created",
        node: "intake",
        actor: "creator",
        parentEventIds: [],
        artifactIds: [],
        payload: { revision: revisionNumber, sourceSnapshotId: snapshotId ?? null }
      });
    }
    return { run: await this.project(result.run, false), created: result.created };
  }

  async list(creatorId: string): Promise<CreatorFactoryRunView[]> {
    return Promise.all((await this.repository.listForCreator(creatorId)).map((run) => this.project(run, false)));
  }

  async get(creatorId: string, runId: string): Promise<CreatorFactoryRunView> {
    return this.project(await this.requireRun(creatorId, runId), true);
  }

  async submitAnswers(
    creatorId: string,
    runId: string,
    request: SubmitFactoryAnswersRequest
  ): Promise<CreatorFactoryRunView> {
    const run = await this.requireRun(creatorId, runId);
    if (!Array.isArray(request.answers)) throw new Error("answers must be an array");
    const answers = new Map<string, string>();
    for (const item of request.answers) {
      const id = requireText(item.questionId, "questionId");
      if (answers.has(id)) throw new Error(`Duplicate Creator answer: ${id}`);
      answers.set(id, requireText(item.answer, `answer for ${id}`));
    }
    let orderedAnswers = [...answers].map(([questionId, answer]) => ({ questionId, answer }));
    const questionBatchId = requireText(request.questionBatchId, "question_batch_id");
    const currentBatchId = run.state?.artifacts.currentQuestionBatch
      ? requireQuestionBatchId(run.id, run.state.artifacts.currentQuestionBatch)
      : undefined;
    if (
      run.status === "waiting_for_creator"
      && questionBatchId
      && currentBatchId
      && questionBatchId !== currentBatchId
    ) {
      if (!request.submissionId?.trim()) {
        throw new CreatorFactoryRepositoryError("version_conflict", "Creator answers target a stale Question batch");
      }
      const replay = await this.repository.submitAnswers({
        creatorId,
        runId,
        answers: {
          answers: orderedAnswers,
          questionBatchId,
          submissionId: request.submissionId.trim()
        },
        ...(request.expectedVersion === undefined ? {} : { expectedVersion: request.expectedVersion })
      });
      return this.project(replay, false);
    }
    if (run.status === "waiting_for_creator" && run.state?.artifacts.currentQuestionBatch) {
      const questions = await this.pendingQuestions(run);
      const expected = new Set(questions.map((item) => item.id));
      const unexpected = [...answers.keys()].filter((id) => !expected.has(id));
      const missing = questions.filter((item) => !answers.has(item.id)).map((item) => item.id);
      if (unexpected.length > 0 || missing.length > 0) {
        throw new Error(`Creator answers do not match pending Questions; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`);
      }
      orderedAnswers = questions.map((question) => ({ questionId: question.id, answer: answers.get(question.id)! }));
    } else if (!request.submissionId?.trim()) {
      throw new CreatorFactoryRepositoryError("invalid_status", `Factory run ${runId} is not waiting for Creator answers`);
    }
    const updated = await this.repository.submitAnswers({
      creatorId,
      runId,
      answers: {
        answers: orderedAnswers,
        questionBatchId,
        ...(request.submissionId?.trim() ? { submissionId: request.submissionId.trim() } : {})
      },
      ...(request.expectedVersion === undefined ? {} : { expectedVersion: request.expectedVersion })
    });
    return this.project(updated, false);
  }

  async retry(creatorId: string, runId: string, expectedVersion?: number): Promise<CreatorFactoryRunView> {
    const current = await this.requireRun(creatorId, runId);
    if (current.status !== "needs_attention" || !current.state?.retryStage) {
      throw new CreatorFactoryRepositoryError("invalid_status", `Factory run ${runId} has no retryable failed stage`);
    }
    const updated = await this.repository.retry({
      creatorId,
      runId,
      ...(expectedVersion === undefined ? {} : { expectedVersion })
    });
    return this.project(updated, false);
  }

  async publishableCorpus(creatorId: string, runId: string): Promise<PublishableFactoryCorpus> {
    const run = await this.requireRun(creatorId, runId);
    const latest = run.state?.artifacts.corpusCandidates.at(-1);
    if (run.status !== "ready" || run.state?.stage !== "ready" || !latest?.agentCorpus) {
      throw notPublishable(runId);
    }
    const store = this.fileStore(run.id);
    try {
      await assertCanonicalPassingHeldout(store, run.state, latest.agentCorpus.heldOut);
    } catch (error) {
      if (error instanceof CreatorFactoryRepositoryError) throw error;
      throw notPublishable(runId);
    }
    return {
      runId: run.id,
      agentId: run.state.agentId,
      product: run.state.product,
      corpusDigest: latest.agentCorpus.digest,
      corpusRoot: path.join(store.directory, ...latest.agentCorpus.rootPath.split("/"))
    };
  }

  /**
   * Commit the control-plane Release after Registry CAS activation succeeds.
   * Approval and publication are one product command, but the graph records
   * the immutable fact only after the live pointer is known to be active.
   */
  async recordRelease(creatorId: string, runId: string, productId: string): Promise<DistillationRelease> {
    const run = await this.requireRun(creatorId, runId);
    if (!this.graphStore || !run.input.taskId) {
      throw new CreatorFactoryRepositoryError("invalid_status", "Distillation graph is unavailable for Release");
    }
    const latest = run.state?.artifacts.corpusCandidates.at(-1);
    const corpusArtifactId = latest?.agentCorpus?.manifest.artifactId;
    const revisionId = run.input.revisionId ?? run.id;
    const distillationRunId = run.input.distillationRunId ?? run.id;
    if (run.status !== "ready" || run.state?.stage !== "ready" || !latest?.agentCorpus || !corpusArtifactId) {
      throw new CreatorFactoryRepositoryError("invalid_status", `Factory run ${runId} is not Release-ready`);
    }
    if (run.input.product?.id && run.input.product.id !== productId) {
      throw new CreatorFactoryRepositoryError("invalid_status", `Factory run ${runId} is bound to another Product`);
    }
    const task = await this.getTask(creatorId, run.input.taskId);
    if (task.productId && task.productId !== productId) {
      throw new CreatorFactoryRepositoryError("invalid_status", `Distillation Task ${task.id} is bound to another Product`);
    }
    await this.graphStore.initialize();
    const graph = await this.graphStore.derive(run.input.taskId);
    if (graph.currentRevisionId && graph.currentRevisionId !== revisionId) {
      throw new CreatorFactoryRepositoryError("invalid_status", `Factory run ${runId} is not the current Task revision`);
    }
    if (!["ready", "released"].includes(graph.status)) {
      throw new CreatorFactoryRepositoryError("invalid_status", `Task ${run.input.taskId} has not passed its current quality gates`);
    }
    const release: DistillationRelease = {
      id: `release_${createHash("sha256").update(`${run.input.taskId}\u0000${revisionId}\u0000${productId}\u0000${corpusArtifactId}`).digest("hex").slice(0, 32)}`,
      taskId: run.input.taskId,
      runId: distillationRunId,
      revisionId,
      productId,
      corpusArtifactId,
      createdAt: latest.agentCorpus.verifiedAt
    };
    const recorded = await this.graphStore.recordRelease(release);
    const parents = (await this.graphStore.listEvents(run.input.taskId))
      .filter((event) => event.runId === distillationRunId && event.revisionId === revisionId)
      .at(-1);
    await this.graphStore.appendEvent({
      id: `evt_${randomUUID().replaceAll("-", "")}`,
      eventKey: `${revisionId}:release_created:${productId}:${corpusArtifactId}`,
      taskId: run.input.taskId,
      runId: distillationRunId,
      revisionId,
      type: "release_created",
      node: "release",
      actor: "system",
      parentEventIds: parents ? [parents.id] : [],
      artifactIds: [corpusArtifactId],
      payload: { productId, corpusDigest: latest.agentCorpus.digest }
    });
    return recorded;
  }

  private async requireRun(creatorId: string, runId: string): Promise<FactoryRunRecord> {
    const run = await this.repository.getForCreator(creatorId, runId);
    if (!run) throw new CreatorFactoryRepositoryError("run_not_found", `Factory run ${runId} was not found`);
    return run;
  }

  private async requireActiveTask(creatorId: string, taskId: string): Promise<void> {
    try {
      const task = await this.getTask(creatorId, taskId);
      if (task.status !== "active") throw new CreatorSourceLibraryError("invalid_source", `Distillation Task ${taskId} is deleted`);
    } catch (error) {
      if (error instanceof CreatorFactoryRepositoryError && error.code === "run_not_found") {
        throw new CreatorSourceLibraryError("invalid_source", `Distillation Task ${taskId} was not found`);
      }
      throw error;
    }
  }

  private async project(run: FactoryRunRecord, includeQuestions: boolean): Promise<CreatorFactoryRunView> {
    const latest = run.state?.artifacts.corpusCandidates.at(-1);
    const readyAgentCorpus = run.status === "ready" && run.state?.stage === "ready"
      ? latest?.agentCorpus
      : undefined;
    const evidence = readyAgentCorpus && run.state && latest
      ? await candidateEvidence(this.fileStore(run.id), run.state, latest)
      : undefined;
    const inputProduct = run.input.product?.id && run.input.product.name
      ? run.input.product as FactoryAgentProduct
      : undefined;
    const projectedProduct = run.state?.product ?? inputProduct;
    const declaredTools = run.state?.tools ?? run.input.tools;
    const graph = run.input.taskId && this.graphStore
      ? await this.graphStore.derive(run.input.taskId)
      : undefined;
    return {
      id: run.id,
      ...(run.state?.agentId || run.input.agentId ? { agentId: run.state?.agentId ?? run.input.agentId } : {}),
      ...(run.input.taskId ? { taskId: run.input.taskId } : {}),
      ...(run.input.distillationRunId ? { distillationRunId: run.input.distillationRunId } : {}),
      ...(run.input.revisionId ? { revisionId: run.input.revisionId } : {}),
      ...(run.input.revisionNumber === undefined ? {} : { revisionNumber: run.input.revisionNumber }),
      ...(run.input.parentRevisionId ? { parentRevisionId: run.input.parentRevisionId } : {}),
      ...(run.input.sourceSnapshotId ? { sourceSnapshotId: run.input.sourceSnapshotId } : {}),
      ...(graph ? { derivedStatus: graph.status, qualityGates: graph.gates.map((gate) => ({ name: gate.name, critical: gate.critical, status: gate.status, ...(gate.reason ? { reason: gate.reason } : {}) })) } : {}),
      // Partial product hints remain private until Factory has normalized them;
      // an already-complete request can be projected while the run is queued.
      ...(projectedProduct ? { product: projectedProduct } : {}),
      ...(declaredTools ? { declaredToolIds: declaredTools.map((tool) => tool.id) } : {}),
      taskName: run.input.taskName,
      status: run.status,
      ...(run.factoryStage ? { stage: run.factoryStage } : {}),
      version: run.version,
      pendingQuestions: includeQuestions && run.status === "waiting_for_creator"
        ? (await this.pendingQuestions(run)).map(({ id, question }) => ({ id, question }))
        : [],
      ...(includeQuestions && run.status === "waiting_for_creator" && run.state?.artifacts.currentQuestionBatch
        ? { questionBatchId: requireQuestionBatchId(run.id, run.state.artifacts.currentQuestionBatch) }
        : {}),
      retryable: run.status === "needs_attention" && !!run.state?.retryStage,
      ...(latest ? { candidate: {
        version: latest.version,
        reason: latest.reason,
        systemDigest: latest.systemInstructions.sha256,
        ...(readyAgentCorpus ? { corpusDigest: readyAgentCorpus.digest } : {}),
        corpusVerified: !!readyAgentCorpus,
        factoryVersion: "creator-factory-contract-1",
        ...(evidence ?? {})
      } } : {}),
      ...(run.lastError ? { lastError: run.lastError } : {}),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt
    };
  }

  private async pendingQuestions(run: FactoryRunRecord): Promise<CreatorQuestion[]> {
    const reference = run.state?.artifacts.currentQuestionBatch;
    if (!reference?.sealed) throw new Error(`Factory run ${run.id} has no sealed pending Question batch`);
    return parseQuestions(await this.fileStore(run.id).readArtifact(reference));
  }

  private fileStore(runId: string): FactoryFileStore {
    return new FactoryFileStore(this.factoryRoot, runId, undefined, undefined, {
      objectStore: this.objectStore
    });
  }

  private taskRepository() {
    if (!isDistillationTaskRepository(this.repository)) {
      throw new CreatorFactoryRepositoryError("invalid_status", "Distillation Task storage is unavailable");
    }
    return this.repository;
  }

  private async nextRevisionNumber(creatorId: string, taskId: string): Promise<number> {
    const runs = await this.repository.listForCreator(creatorId);
    return Math.max(0, ...runs
      .filter((run) => run.input.taskId === taskId)
      .map((run) => run.input.revisionNumber ?? 0)) + 1;
  }
}

function notPublishable(runId: string): CreatorFactoryRepositoryError {
  return new CreatorFactoryRepositoryError(
    "invalid_status",
    `Factory run ${runId} has no verified publishable Agent Corpus`
  );
}

/**
 * Publication authority comes from the sealed evaluation proof that produced
 * the ready state, not merely from the existence of a provisional bundle.
 */
async function assertCanonicalPassingHeldout(
  store: FactoryFileStore,
  state: NonNullable<FactoryRunRecord["state"]>,
  candidateHeldout: ArtifactRef,
): Promise<void> {
  const canonical = state.artifacts.latestHeldoutEvaluation;
  if (
    !canonical?.sealed
    || candidateHeldout.sha256 !== canonical.sha256
  ) {
    throw notPublishable(state.runId);
  }
  const [candidateText, canonicalText] = await Promise.all([
    store.readArtifact(candidateHeldout),
    store.readArtifact(canonical),
  ]);
  if (candidateText !== canonicalText) throw notPublishable(state.runId);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidateText);
  } catch {
    throw notPublishable(state.runId);
  }
  if (!isRecord(parsed)
    || parsed.contract_version !== "1"
    || parsed.evaluation_type !== "held_out"
    || parsed.question_generation !== "llm"
    || parsed.reference_answer_authority !== "creator"
    || Object.prototype.hasOwnProperty.call(parsed, "lifecycle")
    || !Array.isArray(parsed.cases)
    || parsed.cases.length === 0
    || !parsed.cases.every(isPassingHeldoutCase)) {
    throw notPublishable(state.runId);
  }
}

function isPassingHeldoutCase(value: unknown): boolean {
  if (!isRecord(value) || value.verdict !== "PASS") return false;
  return ["id", "question", "creator_reference_answer", "hatch_result", "diagnosis"]
    .every((field) => typeof value[field] === "string" && value[field].trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function candidateEvidence(
  store: FactoryFileStore,
  state: NonNullable<FactoryRunRecord["state"]>,
  latest: NonNullable<FactoryRunRecord["state"]>["artifacts"]["corpusCandidates"][number]
): Promise<{
  reportDigest: string;
  regressionDigest: string;
  heldOutDigest: string;
  heldOutSampleCount: number;
  failedCriticalCases: number;
  builtAt: string;
}> {
  if (!latest.agentCorpus) throw new Error("Candidate evidence requires a materialized Agent Corpus");
  const heldOut = JSON.parse(await store.readArtifact(latest.agentCorpus.heldOut)) as { cases?: Array<{ verdict?: string }> };
  const cases = Array.isArray(heldOut.cases) ? heldOut.cases : [];
  const reportDigest = `sha256:${createHash("sha256").update(JSON.stringify({
    corpus_digest: latest.agentCorpus.digest,
    manifest_digest: latest.agentCorpus.manifest.sha256,
    compile_record_digest: latest.compileRecord.sha256,
    regression_digest: latest.agentCorpus.syntheticQa.sha256,
    held_out_digest: latest.agentCorpus.heldOut.sha256,
    product_boundaries: state.product.boundaries ?? []
  })).digest("hex")}`;
  return {
    reportDigest,
    regressionDigest: latest.agentCorpus.syntheticQa.sha256,
    heldOutDigest: latest.agentCorpus.heldOut.sha256,
    heldOutSampleCount: cases.length,
    failedCriticalCases: cases.filter((item) => item.verdict === "FAIL").length,
    builtAt: latest.agentCorpus.verifiedAt
  };
}

function validateCreateRequest(
  request: CreateFactoryRunRequest
): CreateFactoryRunRequest & { tools: FactoryAgentTool[] } {
  const agentId = request.agentId === undefined ? undefined : requireCorpusIdentifier(request.agentId, "agentId");
  const taskName = requireText(request.taskName, "taskName");
  const taskBrief = requireText(request.taskBrief, "taskBrief");
  const sourceSnapshotId = request.sourceSnapshotId === undefined
    ? undefined
    : requireText(request.sourceSnapshotId, "sourceSnapshotId");
  const taskId = request.taskId === undefined ? undefined : requireText(request.taskId, "taskId");
  const sourceDocumentIds = request.sourceDocumentIds === undefined
    ? undefined
    : [...new Set(request.sourceDocumentIds.map((id) => requireText(id, "sourceDocumentId")))];
  if (sourceSnapshotId && (request.sources !== undefined || sourceDocumentIds !== undefined)) throw new Error("Use sourceSnapshotId, sourceDocumentIds, or inline sources, not multiple source authorities");
  if (!sourceSnapshotId && !sourceDocumentIds?.length && (!Array.isArray(request.sources) || request.sources.length === 0)) throw new Error("sources, sourceDocumentIds, or sourceSnapshotId is required");
  if (request.sources && request.sources.length > 100) throw new Error("A Factory run supports at most 100 source items");
  let total = Buffer.byteLength(taskBrief, "utf8");
  const seen = new Set<string>();
  const sources = (request.sources ?? []).map((source) => {
    const id = requireText(source.id, "source.id");
    if (seen.has(id)) throw new Error(`Duplicate source id: ${id}`);
    seen.add(id);
    if (!["creator_current", "creator_example", "private_material", "public_context"].includes(source.authority)) {
      throw new Error(`Unsupported source authority: ${String(source.authority)}`);
    }
    const content = requireText(source.content, `source ${id} content`);
    total += Buffer.byteLength(id, "utf8")
      + Buffer.byteLength(source.title ?? "", "utf8")
      + Buffer.byteLength(content, "utf8");
    return { id, authority: source.authority, title: requireText(source.title, `source ${id} title`), content };
  });
  if (total > 5 * 1024 * 1024) {
    throw new CreatorFactoryInputTooLargeError("Factory input exceeds 5 MiB; upload or segment material first");
  }
  const config = request.config ? {
    ...(request.config.developmentQuestions === undefined ? {} : {
      developmentQuestions: boundedInteger(request.config.developmentQuestions, "developmentQuestions", 1, 50)
    }),
    ...(request.config.heldoutQuestions === undefined ? {} : {
      heldoutQuestions: boundedInteger(request.config.heldoutQuestions, "heldoutQuestions", 1, 20)
    }),
    ...(request.config.maxCorpusRevisions === undefined ? {} : {
      maxCorpusRevisions: boundedInteger(request.config.maxCorpusRevisions, "maxCorpusRevisions", 1, 10)
    })
  } : undefined;
  const product = request.product === undefined ? undefined : validateProduct(request.product);
  const tools = validateTools(request.tools);
  return {
    ...(taskId ? { taskId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(product ? { product } : {}),
    tools,
    taskName,
    taskBrief,
    ...(request.sources === undefined ? {} : { sources }),
    ...(sourceDocumentIds ? { sourceDocumentIds } : {}),
    ...(sourceSnapshotId ? { sourceSnapshotId } : {}),
    ...(config ? { config } : {})
  };
}

const BUILTIN_TOOLS = [
  { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
  { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" }
] as const satisfies readonly FactoryAgentTool[];

const PRODUCT_KEYS = new Set(["id", "name", "description", "promise", "boundaries", "presentation"]);
const BUILTIN_TOOL_KEYS = new Set(["id", "kind", "capability", "description"]);
const CREATOR_HTTP_TOOL_KEYS = new Set(["id", "kind", "connection_ref", "operation", "description", "input_schema"]);
const CREATOR_MCP_TOOL_KEYS = new Set(["id", "kind", "connection_ref", "tool_name", "description", "input_schema"]);
const TOOL_ID = /^(?:hatch|creator)\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const HATCH_LOCAL_TOOL_ID = /^hatch\.local\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const CREATOR_TOOL_ID = /^creator\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const FORBIDDEN_TOOL_METADATA = /(?:^|[_-])(url|endpoint|secret|provider|credential)s?(?:$|[_-])/i;

function validateProduct(value: Partial<FactoryAgentProduct>): Partial<FactoryAgentProduct> {
  const product = requirePlainObject(value, "product");
  assertOnlyKeys(product, PRODUCT_KEYS, "product");
  const boundaries = product.boundaries;
  if (boundaries !== undefined && !Array.isArray(boundaries)) {
    throw new Error("product.boundaries must be an array");
  }
  return {
    ...(product.id === undefined ? {} : { id: requireCorpusIdentifier(product.id, "product.id") }),
    ...(product.name === undefined ? {} : { name: requireText(product.name, "product.name") }),
    ...(product.description === undefined ? {} : { description: requireText(product.description, "product.description") }),
    ...(product.promise === undefined ? {} : { promise: requireText(product.promise, "product.promise") }),
    ...(boundaries === undefined ? {} : {
      boundaries: boundaries.map((boundary, index) => requireText(boundary, `product.boundaries[${index}]`))
    }),
    ...(product.presentation === undefined ? {} : {
      presentation: { ...requirePlainObject(product.presentation, "product.presentation") }
    })
  };
}

function validateTools(value: FactoryAgentTool[] | undefined): FactoryAgentTool[] {
  if (value !== undefined && !Array.isArray(value)) throw new Error("tools must be an array");
  const explicit = (value ?? []).map((tool, index) => validateTool(tool, index));
  const byId = new Map<string, FactoryAgentTool>();
  for (const tool of explicit) {
    if (byId.has(tool.id)) throw new Error(`Duplicate tool id: ${tool.id}`);
    byId.set(tool.id, tool);
  }
  const web = byId.get("hatch.web_search") ?? { ...BUILTIN_TOOLS[0] };
  const file = byId.get("hatch.file_search") ?? { ...BUILTIN_TOOLS[1] };
  return [web, file, ...explicit.filter((tool) => tool.id !== web.id && tool.id !== file.id)];
}

function validateTool(value: unknown, index: number): FactoryAgentTool {
  const field = `tools[${index}]`;
  const tool = requirePlainObject(value, field);
  const id = requireText(tool.id, `${field}.id`);
  if (!TOOL_ID.test(id)) throw new Error(`${field}.id must be a canonical hatch.* or creator.* tool id`);
  const kind = requireText(tool.kind, `${field}.kind`);
  const description = tool.description === undefined
    ? {}
    : { description: requireText(tool.description, `${field}.description`) };

  if (kind === "hatch_builtin") {
    assertOnlyToolKeys(tool, BUILTIN_TOOL_KEYS, field);
    const capability = requireText(tool.capability, `${field}.capability`);
    if (id === "hatch.web_search" && capability === "web_search") {
      return { id, kind, capability, ...description };
    }
    if (id === "hatch.file_search" && capability === "file_search") {
      return { id, kind, capability, ...description };
    }
    throw new Error(`${field} must be the canonical hatch.web_search or hatch.file_search built-in`);
  }

  if (kind === "local_harness") {
    assertOnlyToolKeys(tool, BUILTIN_TOOL_KEYS, field);
    if (!HATCH_LOCAL_TOOL_ID.test(id)) throw new Error(`${field}.id must be a canonical hatch.local.* id`);
    const capability = requireText(tool.capability, `${field}.capability`);
    if (capability !== "filesystem" && capability !== "shell" && capability !== "git") {
      throw new Error(`${field}.capability must be filesystem, shell, or git`);
    }
    return { id, kind, capability, ...description };
  }

  if (kind === "http_function") {
    assertOnlyToolKeys(tool, CREATOR_HTTP_TOOL_KEYS, field);
    if (!CREATOR_TOOL_ID.test(id)) throw new Error(`${field}.id must be a canonical creator.* id`);
    const connectionRef = requireCorpusIdentifier(tool.connection_ref, `${field}.connection_ref`);
    const operation = requireToolOperation(tool.operation, `${field}.operation`);
    return {
      id,
      kind,
      connection_ref: connectionRef,
      operation,
      ...description,
      ...(tool.input_schema === undefined ? {} : {
        input_schema: { ...requirePlainObject(tool.input_schema, `${field}.input_schema`) }
      })
    };
  }

  if (kind === "mcp_tool") {
    assertOnlyToolKeys(tool, CREATOR_MCP_TOOL_KEYS, field);
    if (!CREATOR_TOOL_ID.test(id)) throw new Error(`${field}.id must be a canonical creator.* id`);
    const connectionRef = requireCorpusIdentifier(tool.connection_ref, `${field}.connection_ref`);
    const toolName = requireToolOperation(tool.tool_name, `${field}.tool_name`);
    return {
      id,
      kind,
      connection_ref: connectionRef,
      tool_name: toolName,
      ...description,
      ...(tool.input_schema === undefined ? {} : {
        input_schema: { ...requirePlainObject(tool.input_schema, `${field}.input_schema`) }
      })
    };
  }

  throw new Error(`${field}.kind must be hatch_builtin, local_harness, http_function, or mcp_tool`);
}

function assertOnlyToolKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const forbidden = unknown.find((key) => FORBIDDEN_TOOL_METADATA.test(key));
  if (forbidden) {
    throw new Error(`${field}.${forbidden} is forbidden; Agent Corpus tools must not contain URLs, endpoints, providers, secrets, or credentials`);
  }
  if (unknown.length > 0) throw new Error(`${field} contains unsupported field: ${unknown[0]}`);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${field} contains unsupported field: ${unknown[0]}`);
}

function requirePlainObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${field} must be a plain object`);
  return value as Record<string, unknown>;
}

function requireToolOperation(value: unknown, field: string): string {
  const normalized = requireText(value, field);
  if (URL_LIKE.test(normalized)) throw new Error(`${field} must be an operation name, not a URL or endpoint`);
  return normalized;
}

function requireCorpusIdentifier(value: unknown, field: string): string {
  const normalized = requireText(value, field);
  if (normalized.length > 128 || !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(normalized)) {
    throw new Error(`${field} must be a lowercase Agent Corpus identifier`);
  }
  return normalized;
}

function requireText(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/**
 * Read-time migration for Tasks created before product_id was persisted.
 * The value is deterministic so two concurrent first revisions cannot invent
 * different Product identities. New Tasks always receive a random UUID at
 * creation time.
 */
function deterministicTaskProductId(taskId: string): string {
  const bytes = createHash("sha256").update(`hatch-task-product:${taskId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
