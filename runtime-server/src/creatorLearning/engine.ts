import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  corpusCompletenessPrompt,
  corpusPrompt,
  evidencePrompt,
  evidenceSynthesisPrompt,
  evaluationPrompt,
  questionPrompt
} from "./prompts.js";
import {
  parseCorpusCompilation,
  parseCreatorAnswers,
  parseEvaluation,
  parseQaSet,
  parseQuestions,
  renderCreatorAnswerTemplate,
  renderQaSet
} from "./markdown.js";
import {
  auditCompilationContinuity,
  auditRawSourceOverlap,
  parseRawSourcesFromPacket
} from "./corpusReleaseGuards.js";
import type { CorpusReleaseGuardViolation } from "./corpusReleaseGuards.js";
import { materializeAgentCorpusBundle } from "./corpusBundle.js";
import { FactoryFileStore } from "./fileStore.js";
import type { ArtifactObjectStore } from "./objectStore.js";
import type { DistillationGraphStore } from "./distillationGraph.js";
import { classifyFactoryProviderFailure } from "./factoryLlm.js";
import { issueQuestionBatch, requireQuestionBatchId } from "./questionBatch.js";
import { requireUuidV4 } from "../identity.js";
import { validateFactorySourceManifest } from "./sourceScope.js";
import type {
  ActiveQaEvaluationScope,
  ArtifactRef,
  CorpusCandidate,
  CreatorAnswerInput,
  CreatorQa,
  CreatorQuestion,
  FactoryPromptCall,
  FactoryPromptRunner,
  FactoryExecutionControl,
  FactoryAgentTool,
  FactorySourceManifest,
  FactorySourceImageArtifact,
  HatchCandidateExecutor,
  HatchCandidateResult,
  FactoryRunState,
  FactoryStartInput,
  QaEvaluation
} from "./types.js";

const PROMPT_VERSION = "creator-factory-v7-provenance-and-reasoning-contract";
const SEALED_FAILURE_MESSAGE = "Sealed Factory operation failed; sensitive diagnostics were not persisted";
// Conservative character ceiling leaves ample room inside Kimi K2.6's context
// context for instructions, multilingual tokenization, reasoning, and output.
const EVIDENCE_CHUNK_CHARACTERS = 600_000;
const INITIAL_EVIDENCE_SECTIONS = [
  "Product evidence",
  "Decision rules",
  "Cases",
  "Boundaries",
  "Intellectual genealogy",
  "Provenance hypotheses",
  "Layer routing candidates",
  "Unknowns and contradictions"
];
const CONSOLIDATED_EVIDENCE_SECTIONS = [
  ...INITIAL_EVIDENCE_SECTIONS,
  "Fragment preservation audit"
];

export type CreatorFactoryOptions = {
  model?: { provider: string; model: string };
  /** Production artifacts are authoritative in the configured Object Store. */
  objectStore?: ArtifactObjectStore;
  /** Postgres-backed append-only graph and quality-gate authority. */
  graphStore?: DistillationGraphStore;
  /** Injectable only for deterministic timing tests. */
  timingClock?: {
    wallNow: () => Date;
    monotonicNow: () => number;
  };
};

export class CreatorFactory {
  constructor(
    private readonly root: string,
    private readonly runPrompt: FactoryPromptRunner,
    private readonly executeCandidate: HatchCandidateExecutor,
    private readonly options: CreatorFactoryOptions = {}
  ) {}

  async start(input: FactoryStartInput, control: FactoryExecutionControl = {}): Promise<FactoryRunState> {
    // Snapshot the entire verified input before the first await. `beforeCommit`
    // is external code and may run during initialize/write operations; using
    // the caller-owned object after that point would permit a manifest/packet
    // TOCTOU where validated sources differ from the bytes sent to the LLM.
    const startInput = structuredClone(input);
    validateStartInput(startInput);
    const identity = normalizeFactoryIdentity(startInput);
    const sourcePacketText = renderSourcePacket(startInput.sources);
    const sourceManifestText = startInput.sourceManifest
      ? `${JSON.stringify(startInput.sourceManifest, null, 2)}\n`
      : undefined;
    const store = this.fileStore(startInput.runId, control, {
      ...(startInput.productId ? { productId: startInput.productId } : {}),
      ...(startInput.distillationRunId ? { runId: startInput.distillationRunId } : {}),
      ...(startInput.revisionId ? { revisionId: startInput.revisionId } : {})
    });
    await store.initialize();
    try {
    let reviewContextArtifact: ArtifactRef | undefined;
    let calibrationArtifact: ArtifactRef | undefined;
    let promotedHeldoutQa: CreatorQa[] = [];
    let seededReviewState: FactoryRunState | undefined;
    let seededEvidence: ArtifactRef | undefined;
    let seededDevelopmentQa: ArtifactRef | undefined;
    let seededRegressionSet: ArtifactRef | undefined;
    let seededHeldoutRounds: ArtifactRef[] = [];
    let seededCorpusCandidates: CorpusCandidate[] = [];
    if (startInput.reviewContext) {
      const sourceRun = startInput.reviewContext.sourceRunId.trim();
      if (!sourceRun || sourceRun === store.runId) throw new Error("Review context must reference a previous Factory run");
      const sourceStore = this.fileStore(sourceRun, control);
      const reviewText = await sourceStore.readArtifact(startInput.reviewContext.artifact);
      // Held-out context stays sealed until the Creator explicitly confirms
      // the failure through a new revision command.
      reviewContextArtifact = await store.writeArtifact(
        `review/context-${shortId()}.json`,
        reviewText,
        startInput.reviewContext.mode === "heldout_correction"
      );
      if (startInput.reviewContext.calibrationArtifact) {
        calibrationArtifact = await store.writeArtifact(
          `review/calibration-${shortId()}.json`,
          await sourceStore.readArtifact(startInput.reviewContext.calibrationArtifact)
        );
      }
      if (startInput.reviewContext.mode === "heldout_correction") {
        promotedHeldoutQa = parsePromotedHeldoutCases(reviewText);
      }
      // A correction is already a Creator decision. Re-asking the entire
      // reference questionnaire would make the Review command look like a
      // new intake and would lose the Corpus n-1 continuity promised by the
      // workflow. Seed only the prior, non-secret checkpoints; every copied
      // artifact gets a new immutable identity in this revision.
      if (startInput.reviewContext.mode !== "question_replacement") {
        seededReviewState = await sourceStore.loadState();
        const copy = async (reference: ArtifactRef, relativePath: string, sealed = Boolean(reference.sealed)): Promise<ArtifactRef> => (
          store.writeArtifact(relativePath, await sourceStore.readArtifact(reference), sealed)
        );
        if (seededReviewState.artifacts.evidence) {
          seededEvidence = await copy(seededReviewState.artifacts.evidence, "evidence/reused-from-parent.md");
        }
        if (seededReviewState.artifacts.developmentQa) {
          seededDevelopmentQa = await copy(seededReviewState.artifacts.developmentQa, "qa/development-reused-from-parent.md");
        }
        if (seededReviewState.artifacts.regressionSet) {
          seededRegressionSet = await copy(seededReviewState.artifacts.regressionSet, "qa/regression-reused-from-parent.md");
        }
        seededHeldoutRounds = await Promise.all(seededReviewState.artifacts.heldoutRounds.map((reference, index) => (
          copy(reference, `qa/heldout-reused-round-${index + 1}.md`, true)
        )));
        seededCorpusCandidates = await Promise.all(seededReviewState.artifacts.corpusCandidates.map(async (candidate) => ({
          version: candidate.version,
          systemInstructions: await store.writeCandidate(
            `parent-v${candidate.version}/agent-corpus/instructions/system.md`,
            await sourceStore.readArtifact(candidate.systemInstructions)
          ),
          compileRecord: await store.writeCandidate(
            `parent-v${candidate.version}/compile-record.md`,
            await sourceStore.readArtifact(candidate.compileRecord)
          ),
          reason: candidate.reason,
          ...(candidate.completeness === undefined
            ? (candidate.agentCorpus ? { completeness: "PASS" as const } : {})
            : { completeness: candidate.completeness })
        })));
      }
    }
    const productPromise = await store.writeArtifact("input/product-brief.md", startInput.productPromise);
    const sourceManifest = sourceManifestText
      ? await store.writeArtifact(
          "input/source-manifest.json",
          sourceManifestText
        )
      : undefined;
    const sourcePacket = await store.writeArtifact("input/source-packet.md", sourcePacketText);
    const sourceImages: FactorySourceImageArtifact[] = [];
    for (const source of startInput.sources) {
      if (!source.image) continue;
      const artifact = await store.writeArtifact(`input/images/${source.id}.base64`, source.image.base64);
      sourceImages.push({ sourceId: source.id, mediaType: source.image.mediaType, artifact });
    }
    const now = new Date().toISOString();
    const config = {
      developmentQuestions: startInput.config?.developmentQuestions ?? 6,
      heldoutQuestions: startInput.config?.heldoutQuestions ?? 3,
      // A production run can need one revision for deterministic repair and
      // several more for Creator-reference calibration. Keep the explicit
      // per-run override authoritative, but give new runs enough bounded
      // room to converge before requiring a new source/correction revision.
      maxCorpusRevisions: startInput.config?.maxCorpusRevisions ?? 6
    };
    const directReviewRevision = Boolean(seededReviewState && seededEvidence && seededDevelopmentQa);
    const heldoutCorrection = startInput.reviewContext?.mode === "heldout_correction";
    let state: FactoryRunState = {
      contractVersion: "1",
      runId: store.runId,
      creator: startInput.creator,
      agentId: identity.agentId,
      product: identity.product,
      tools: normalizeFactoryTools(startInput.tools),
      productName: startInput.productName,
      ...(startInput.productId ? { productId: startInput.productId } : {}),
      ...(startInput.distillationRunId ? { distillationRunId: startInput.distillationRunId } : {}),
      ...(startInput.revisionId ? { revisionId: startInput.revisionId } : {}),
      ...(startInput.revisionNumber === undefined ? {} : { revisionNumber: startInput.revisionNumber }),
      ...(startInput.parentRevisionId ? { parentRevisionId: startInput.parentRevisionId } : {}),
      ...(startInput.sourceSnapshotId ? { sourceSnapshotId: startInput.sourceSnapshotId } : {}),
      stage: directReviewRevision ? "compiling_corpus" : "extracting_evidence",
      config,
      artifacts: {
        productPromise,
        sourcePacket,
        ...(sourceManifest ? { sourceManifest } : {}),
        ...(sourceImages.length ? { sourceImages } : {}),
        ...(seededEvidence ? { evidence: seededEvidence } : {}),
        ...(seededDevelopmentQa ? { developmentQa: seededDevelopmentQa } : {}),
        ...(reviewContextArtifact ? { reviewContext: reviewContextArtifact } : {}),
        corpusCandidates: seededCorpusCandidates,
        evaluationRounds: [],
        heldoutRounds: seededHeldoutRounds,
        ...(seededRegressionSet ? { regressionSet: seededRegressionSet } : {})
      },
      replacementHeldoutNeeded: heldoutCorrection ? config.heldoutQuestions : 0,
      corpusRevisionCount: 0,
      developmentEvaluated: directReviewRevision,
      ...(directReviewRevision ? { compileReason: heldoutCorrection ? "heldout_failure" : "development_failure" } : {}),
      ...((startInput.reviewContext?.mode === "heldout_correction"
        ? calibrationArtifact
        : reviewContextArtifact)
        ? {
          calibrationFeedback: [
            (startInput.reviewContext?.mode === "heldout_correction" ? calibrationArtifact : reviewContextArtifact)!
          ]
        }
        : {}),
      createdAt: now,
      updatedAt: now
    };
    if (promotedHeldoutQa.length) {
      state.artifacts.regressionSet = await this.mergeRegression(store, state.artifacts.regressionSet, promotedHeldoutQa);
    }
    await store.saveState(state);
    await store.recordEvent("factory_started", {
      stage: state.stage,
      ...(startInput.sourceManifest ? {
        sourceCompleteness: startInput.sourceManifest.completeness,
        sourceFileCount: startInput.sourceManifest.file_count,
        sourceRootDigest: startInput.sourceManifest.root_digest
      } : {})
    });

    return this.resume(state.runId, control);
    } catch (error) {
      // Before the first state checkpoint, a failed intake can leave a
      // directory containing immutable inputs but no authority checkpoint.
      // Release only the operational lease so a same-process retry can reuse
      // those bytes; complete runs remain protected by state.json.
      await store.abortInitialization().catch(() => undefined);
      throw error;
    }
  }

  async submitCreatorAnswers(
    runId: string,
    answers: string | CreatorAnswerInput[],
    questionBatchId: string,
    control: FactoryExecutionControl = {}
  ): Promise<FactoryRunState> {
    const store = this.fileStore(runId, control);
    let state = await store.loadState();
    await this.verifyDurableSourceSnapshot(store, state);
    if (state.stage !== "awaiting_creator_answers" || !state.pendingQuestionBatch || !state.artifacts.currentQuestionBatch) {
      throw new Error(`Factory run ${runId} is not awaiting Creator answers`);
    }
    const currentQuestionBatch = state.artifacts.currentQuestionBatch;
    if (typeof questionBatchId !== "string" || !questionBatchId.trim()) {
      throw new Error("Creator answers require the run-scoped Question batch ID");
    }
    if (questionBatchId.trim() !== requireQuestionBatchId(runId, currentQuestionBatch)) {
      throw new Error(`Creator answers target a stale or unknown Question batch for Factory run ${runId}`);
    }
    const questions = parseQuestions(await store.readArtifact(currentQuestionBatch));
    const qa = typeof answers === "string"
      ? parseCreatorAnswers(answers, questions)
      : creatorQaFromStructuredAnswers(answers, questions);
    if (qa.length !== questions.length) {
      const answered = new Set(qa.map((item) => item.id));
      const missing = questions.filter((item) => !answered.has(item.id)).map((item) => item.id);
      throw new Error(`Creator answers are incomplete; missing: ${missing.join(", ")}`);
    }

    const round = state.artifacts.heldoutRounds.length + 1;
    if (state.pendingQuestionBatch.purpose === "initial") {
      const partitioned = stablePartition(qa, state.runId, state.config.developmentQuestions);
      state.artifacts.developmentQa = await store.writeArtifact(
        "qa/development.md",
        renderQaSet("Development QA", partitioned.development)
      );
      const heldout = await store.writeArtifact(
        `qa/heldout-round-${round}.md`,
        renderQaSet(`Held-out QA round ${round}`, partitioned.heldout),
        true
      );
      state.artifacts.heldoutRounds.push(heldout);
      state.compileReason = state.artifacts.reviewContext ? "development_failure" : "initial";
      state.stage = "compiling_corpus";
    } else {
      const heldout = await store.writeArtifact(
        `qa/heldout-round-${round}.md`,
        renderQaSet(`Held-out QA round ${round}`, qa),
        true
      );
      state.artifacts.heldoutRounds.push(heldout);
      state.replacementHeldoutNeeded = 0;
      state.stage = "evaluating_heldout";
    }
    const submitted = await store.writeArtifact(
      `creator/answers-round-${round}.md`,
      renderQaSet(`Creator answers round ${round}`, qa),
      true
    );
    state.pendingQuestionBatch = undefined;
    state.artifacts.currentQuestionBatch = undefined;
    state.artifacts.creatorAnswerTemplate = submitted;
    await store.saveState(state);
    await store.recordEvent("creator_answers_submitted", { count: qa.length, nextStage: state.stage });
    return this.resume(runId, control);
  }

  async resume(runId: string, control: FactoryExecutionControl = {}): Promise<FactoryRunState> {
    const store = this.fileStore(runId, control);
    let state = await store.loadState();

    try {
      await this.verifyDurableSourceSnapshot(store, state);
      if (state.stage === "awaiting_creator_answers" || state.stage === "review_required" || state.stage === "ready" || state.stage === "needs_attention") {
        return state;
      }
      for (let step = 0; step < 100; step += 1) {
        if (state.stage === "extracting_evidence") state = await this.extractEvidenceAndRequestAnswers(store, state);
        else if (state.stage === "compiling_corpus") state = await this.compileCorpus(store, state);
        else if (state.stage === "evaluating_development") state = await this.evaluateDevelopment(store, state);
        else if (state.stage === "evaluating_regression") state = await this.evaluateRegression(store, state);
        else if (state.stage === "evaluating_heldout") state = await this.evaluateHeldout(store, state);
        else return state;
        await store.saveState(state);
        if (state.stage === "awaiting_creator_answers" || state.stage === "review_required" || state.stage === "ready" || state.stage === "needs_attention") {
          const checkpoint = await store.loadState();
          await this.verifyDurableSourceSnapshot(store, checkpoint);
          return checkpoint;
        }
      }
      throw new Error("Factory exceeded its workflow step limit");
    } catch (error) {
      if (control.signal?.aborted) throw error;
      return this.needsAttention(store, state, error);
    }
  }

  async status(runId: string): Promise<FactoryRunState> {
    const store = this.fileStore(runId);
    const state = await store.loadState();
    await this.verifyDurableSourceSnapshot(store, state);
    return state;
  }

  async retry(runId: string, control: FactoryExecutionControl = {}): Promise<FactoryRunState> {
    const store = this.fileStore(runId, control);
    const state = await store.loadState();
    await this.verifyDurableSourceSnapshot(store, state);
    if (state.stage !== "needs_attention" || !state.retryStage) {
      throw new Error(`Factory run ${runId} has no retryable failed stage`);
    }
    const next = { ...state, stage: state.retryStage, retryStage: undefined, lastError: undefined };
    await store.saveState(next);
    await store.recordEvent("factory_retry_requested", { stage: next.stage });
    return this.resume(runId, control);
  }

  private async extractEvidenceAndRequestAnswers(
    store: FactoryFileStore,
    state: FactoryRunState
  ): Promise<FactoryRunState> {
    const productPromise = await store.readArtifact(state.artifacts.productPromise);
    const sourcePacket = await store.readArtifact(state.artifacts.sourcePacket);
    const sourceImages = await readSourceImages(store, state);
    const evidenceInput = {
      creator: state.creator,
      productName: state.productName,
      productPromise
    };
    const chunks = chunkEvidenceSourcePacket(sourcePacket, EVIDENCE_CHUNK_CHARACTERS);
    const fragmentOutputs: Array<{ id: string; evidence: string }> = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const id = `source-chunk-${index + 1}-of-${chunks.length}`;
      const evidenceCall = evidencePrompt(
        evidenceInput,
        chunks.length === 1
          ? chunks[index]!
          : `Packet scope: ${id}. This is one losslessly partitioned part of the authorized packet; extract it fully and do not infer that absent parts are absent from the Creator's overall method.\n\n${chunks[index]!}`
      );
      fragmentOutputs.push({
        id,
        evidence: await this.call(
          store,
          {
            purpose: "evidence.extract",
            outputContract: {
              kind: "evidence_ledger",
              requiredSections: INITIAL_EVIDENCE_SECTIONS
            },
            ...(sourceImages.length ? { images: sourceImages } : {}),
            ...evidenceCall
          },
          chunks.length === 1 ? "evidence" : `evidence-${id}`,
          false
        )
      });
    }
    const evidence = fragmentOutputs.length === 1
      ? fragmentOutputs[0]!.evidence
      : await this.call(
        store,
        {
          purpose: "evidence.extract",
          outputContract: {
            kind: "evidence_ledger",
            requiredSections: CONSOLIDATED_EVIDENCE_SECTIONS
          },
          ...evidenceSynthesisPrompt(evidenceInput, fragmentOutputs)
        },
        "evidence-lossless-consolidation",
        false
      );
    state.artifacts.evidence = await store.writeArtifact(`evidence/evidence-${shortId()}.md`, evidence);

    const total = state.config.developmentQuestions + state.config.heldoutQuestions;
    const questions = await this.generateQuestions(store, state, total, "I");
    const questionBatch = issueQuestionBatch(
      state.runId,
      await store.writeArtifact(
        `question-batches/initial-questions-${shortId()}.md`,
        renderQuestionBatch("Initial Creator questions", questions),
        true
      )
    );
    const creatorAnswerTemplate = await store.writeArtifact(
      `creator/initial-answer-template-${shortId()}.md`,
      renderCreatorAnswerTemplate(questions, questionBatch.batchId),
      true
    );
    state.stage = "awaiting_creator_answers";
    state.artifacts.currentQuestionBatch = questionBatch;
    state.artifacts.creatorAnswerTemplate = creatorAnswerTemplate;
    state.pendingQuestionBatch = { purpose: "initial", count: total };
    await store.recordEvent("creator_answers_requested", { purpose: "initial", count: total });
    return state;
  }

  /**
   * Cross-bind the two durable source artifacts on every recovery boundary.
   * ArtifactRef verification catches deletion/replacement, while reparsing the
   * reversible packet and revalidating per-file hashes proves it still equals
   * the exhaustive manifest before any further LLM or ready-state action.
   */
  private async verifyDurableSourceSnapshot(
    store: FactoryFileStore,
    state: FactoryRunState
  ): Promise<void> {
    const reference = state.artifacts.sourceManifest;
    if (!reference) return; // Legacy manually listed sources remain readable.
    const rawManifest = await store.readArtifact(reference);
    let manifest: FactorySourceManifest;
    try {
      manifest = JSON.parse(rawManifest) as FactorySourceManifest;
    } catch {
      throw new Error("Factory source manifest artifact is not valid JSON");
    }
    const sourcePacket = await store.readArtifact(state.artifacts.sourcePacket);
    validateFactorySourceManifest(manifest, parseRawSourcesFromPacket(sourcePacket));
  }

  private async compileCorpus(store: FactoryFileStore, state: FactoryRunState): Promise<FactoryRunState> {
    if (!state.artifacts.evidence || !state.artifacts.developmentQa || !state.compileReason) {
      throw new Error("Corpus compilation is missing Evidence, Development QA, or compile reason");
    }
    const availableToolIds = factoryTools(state).map((tool) => tool.id);
    const latestCandidate = state.artifacts.corpusCandidates.at(-1);
    if (latestCandidate
      && latestCandidate.completeness === undefined
      && latestCandidate.reason === state.compileReason
      && !latestCandidate.agentCorpus
      && !hasCompletenessReportReference(state, latestCandidate.version)) {
      if (latestCandidate.version !== state.artifacts.corpusCandidates.length
        || state.artifacts.pendingGuardCandidate) {
        throw new Error("Pending Corpus completeness checkpoint is inconsistent with run state");
      }
      return this.auditPendingCorpusCompleteness(store, state, availableToolIds);
    }
    await this.restoreLegacyInconclusiveGuardCandidate(store, state);
    await this.restoreLegacyCompletenessRepairTarget(store, state);
    const pendingGuardCandidate = state.artifacts.pendingGuardCandidate;
    if (!pendingGuardCandidate
      && state.compileReason !== "initial"
      && state.corpusRevisionCount >= state.config.maxCorpusRevisions) {
      throw new Error(`Corpus did not converge after ${state.config.maxCorpusRevisions} revisions`);
    }
    const version = pendingGuardCandidate?.candidateVersion
      ?? state.artifacts.corpusCandidates.length + 1;
    if (version !== state.artifacts.corpusCandidates.length + 1) {
      throw new Error("Pending Corpus guard candidate does not target the next candidate version");
    }
    const acceptedHistory = await acceptedCorpusHistory(store, state, availableToolIds);
    const previousCompilation = acceptedHistory.at(-1)?.raw;
    const rejectedRepairTarget = state.artifacts.rejectedCorpusRepairTarget;
    const rejectedRepairCompilation = rejectedRepairTarget
      ? await store.readArtifact(rejectedRepairTarget.compilation)
      : undefined;
    const rejectedRepairFailure = rejectedRepairTarget
      ? await store.readArtifact(rejectedRepairTarget.failureReport)
      : undefined;
    // Sealed held-out reports are durable audit artifacts, but they are never
    // compiler input. Older revisions may have persisted a sealed report in
    // calibrationFeedback before the correction boundary was enforced, so
    // fail closed here as well as at revision creation time.
    const evaluationFeedback = (await Promise.all(
      (state.calibrationFeedback ?? [])
        .filter((reference) => !reference.sealed)
        .map((reference) => store.readArtifact(reference))
    )).join("\n\n---\n\n");
    const regression = state.artifacts.regressionSet
      ? parseQaSet(await store.readArtifact(state.artifacts.regressionSet))
      : [];
    let raw: string;
    let compileReason = state.compileReason;
    if (pendingGuardCandidate) {
      if (pendingGuardCandidate.reason !== compileReason) {
        throw new Error("Pending Corpus guard candidate compile reason does not match run state");
      }
      raw = await store.readArtifact(pendingGuardCandidate.compilation);
    } else {
      const call = corpusPrompt({
        creatorName: state.creator.name,
        productName: state.productName,
        productPromise: await store.readArtifact(state.artifacts.productPromise),
        productContract: renderProductContract(state.product),
        evidence: await store.readArtifact(state.artifacts.evidence),
        developmentQa: parseQaSet(await store.readArtifact(state.artifacts.developmentQa)),
        evaluationFeedback,
        regression,
        availableToolIds: factoryTools(state).map((tool) => tool.id),
        previousCompilation,
        rejectedRepairCompilation,
        rejectedRepairFailure,
        reason: compileReason
      });
      raw = await this.call(store, {
        purpose: "corpus.compile",
        outputContract: { kind: "corpus_compilation", availableToolIds },
        ...call
      }, `corpus-v${version}`, false);
    }
    const compilation = parseCorpusCompilation(raw, { availableToolIds });
    if (!pendingGuardCandidate) {
      const pendingCompilation = await store.writeArtifact(
        `guard-candidates/candidate-v${version}-${shortId()}.md`,
        raw
      );
      state.artifacts.pendingGuardCandidate = {
        candidateVersion: version,
        compilation: pendingCompilation,
        reason: compileReason
      };
      // Count each non-initial compiler output exactly once at its durable
      // checkpoint. Retrying a bounded host audit never consumes a revision.
      if (compileReason !== "initial") state.corpusRevisionCount += 1;
      await store.saveState(state);
    }
    const releaseGuardViolations = [
      ...auditCompilationContinuity(acceptedHistory.map((entry) => entry.compilation), compilation),
      ...auditRawSourceOverlap(
        compilation,
        parseRawSourcesFromPacket(await store.readArtifact(state.artifacts.sourcePacket))
      )
    ];
    const provenViolations = releaseGuardViolations.filter((violation) => (
      violation.code !== "raw_source_overlap_inconclusive"
    ));
    if (provenViolations.length > 0) {
      await this.invalidateSupersededLegacyGuardReports(store, state, version);
      return this.rejectCorpusForReleaseGuard(store, state, version, raw, provenViolations);
    }
    if (releaseGuardViolations.length > 0) {
      return this.deferCorpusForGuardRecheck(store, state, version, releaseGuardViolations);
    }
    await this.invalidateSupersededLegacyGuardReports(store, state, version);
    const candidatePath = `v${version}-${shortId()}`;
    const compileRecord = await store.writeCandidate(`${candidatePath}/compile-record.md`, raw);
    const systemInstructions = await store.writeCandidate(
      `${candidatePath}/agent-corpus/instructions/system.md`,
      `${compilation.systemInstructions}\n`
    );
    state.artifacts.pendingGuardCandidate = undefined;
    state.artifacts.rejectedCorpusRepairTarget = undefined;
    state.artifacts.corpusCandidates.push({
      version,
      systemInstructions,
      compileRecord,
      reason: compileReason
    });
    // This is the durable checkpoint between deterministic guards and the
    // external completeness audit. A provider failure resumes from these exact
    // candidate bytes and never invokes corpus.compile again.
    await store.saveState(state);
    return this.auditPendingCorpusCompleteness(store, state, availableToolIds);
  }

  private async auditPendingCorpusCompleteness(
    store: FactoryFileStore,
    state: FactoryRunState,
    availableToolIds: string[]
  ): Promise<FactoryRunState> {
    const candidate = state.artifacts.corpusCandidates.at(-1);
    const evidence = state.artifacts.evidence;
    const developmentQa = state.artifacts.developmentQa;
    if (!candidate || candidate.completeness !== undefined || !evidence || !developmentQa) {
      throw new Error("Corpus completeness audit has no pending candidate");
    }
    const raw = await store.readArtifact(candidate.compileRecord);
    const compilation = parseCorpusCompilation(raw, { availableToolIds });
    const persistedSystem = await store.readArtifact(candidate.systemInstructions);
    if (persistedSystem !== `${compilation.systemInstructions}\n`) {
      throw new Error("Pending Corpus completeness checkpoint does not match its compile record");
    }
    const acceptedHistory = await acceptedCorpusHistory(store, state, availableToolIds);
    const previousCompilation = acceptedHistory
      .filter((entry) => entry.version < candidate.version)
      .at(-1)?.raw;
    const regression = state.artifacts.regressionSet
      ? parseQaSet(await store.readArtifact(state.artifacts.regressionSet))
      : [];
    const completenessCall = corpusCompletenessPrompt({
      creatorName: state.creator.name,
      productName: state.productName,
      productPromise: await store.readArtifact(state.artifacts.productPromise),
      productContract: renderProductContract(state.product),
      evidence: await store.readArtifact(evidence),
      developmentQa: parseQaSet(await store.readArtifact(developmentQa)),
      regression,
      availableToolIds,
      previousCompilation,
      candidateCompilation: raw
    });
    const rawCompleteness = await this.call(
      store,
      {
        purpose: "eval.audit_corpus",
        outputContract: { kind: "corpus_audit" },
        ...completenessCall
      },
      `corpus-completeness-v${candidate.version}`,
      false
    );
    const completeness = parseEvaluation(rawCompleteness);
    const completenessReport = await store.writeArtifact(
      `evaluations/corpus-completeness-v${candidate.version}-${shortId()}.md`,
      rawCompleteness
    );
    state.artifacts.evaluationRounds.push(completenessReport);
    if (!completeness.pass) {
      candidate.completeness = "FAIL";
      const priorTarget = state.artifacts.rejectedCorpusRepairTarget;
      state.artifacts.rejectedCorpusRepairTarget = {
        attempt: priorTarget?.candidateVersion === candidate.version ? priorTarget.attempt + 1 : 1,
        candidateVersion: candidate.version,
        compilation: candidate.compileRecord,
        failureReport: completenessReport,
        reason: "completeness_failure"
      };
      state.calibrationFeedback = [completenessReport];
      state.compileReason = "completeness_failure";
      state.stage = "compiling_corpus";
      await store.recordEvent("corpus_completeness_failed", {
        version: candidate.version,
        report: completenessReport,
        diagnosis: completeness.diagnosis,
        nextStage: state.stage
      });
      return state;
    }

    candidate.completeness = "PASS";
    state.calibrationFeedback = undefined;
    state.compileReason = undefined;
    state.stage = regression.length > 0
      ? "evaluating_regression"
      : state.developmentEvaluated ? "evaluating_heldout" : "evaluating_development";
    await store.recordEvent("corpus_compiled", {
      version: candidate.version,
      completeness: "PASS",
      nextStage: state.stage
    });
    return state;
  }

  private async rejectCorpusForReleaseGuard(
    store: FactoryFileStore,
    state: FactoryRunState,
    version: number,
    rawCompilation: string,
    violations: CorpusReleaseGuardViolation[]
  ): Promise<FactoryRunState> {
    const pending = state.artifacts.pendingGuardCandidate;
    if (!pending || pending.candidateVersion !== version) {
      throw new Error("Release guard rejection is missing its durable pending candidate");
    }
    const priorTarget = state.artifacts.rejectedCorpusRepairTarget;
    const isLegacyRecheck = priorTarget?.candidateVersion === version
      && sameArtifact(priorTarget.compilation, pending.compilation);
    const attempt = isLegacyRecheck
      ? priorTarget.attempt
      : (priorTarget?.attempt ?? 0) + 1;
    const compilation = isLegacyRecheck
      ? priorTarget.compilation
      : await store.writeArtifact(
        `rejected-corpus/attempt-${attempt}-candidate-v${version}-${shortId()}.md`,
        rawCompilation
      );
    const report = await store.writeArtifact(
      `evaluations/corpus-release-guard-v${version}-${shortId()}.md`,
      [
        "# Deterministic Corpus release guard",
        "",
        "## Verdict",
        "FAIL",
        "",
        "## Diagnosis",
        ...violations.map((violation) => `- [${violation.code}] ${violation.detail}`),
        "",
        "## Few-shot candidate",
        "None. Repair the identified asset without copying raw source prose.",
        "",
        "## Corpus reflection",
        "Produce a complete synthesis that preserves every accepted asset and expresses source-derived knowledge in original wording.",
        ""
      ].join("\n")
    );
    state.artifacts.evaluationRounds.push(report);
    state.calibrationFeedback = [report];
    state.artifacts.pendingGuardCandidate = undefined;
    state.artifacts.rejectedCorpusRepairTarget = {
      attempt,
      candidateVersion: version,
      compilation,
      failureReport: report,
      reason: "release_guard"
    };
    state.compileReason = "completeness_failure";
    state.stage = "compiling_corpus";
    await store.recordEvent("corpus_release_guard_failed", {
      version,
      report,
      violations: violations.map(({ code, assetPath, sourceId }) => ({
        code,
        assetPath,
        ...(sourceId ? { sourceId } : {})
      })),
      nextStage: state.stage
    });
    return state;
  }

  private async deferCorpusForGuardRecheck(
    store: FactoryFileStore,
    state: FactoryRunState,
    version: number,
    violations: CorpusReleaseGuardViolation[]
  ): Promise<FactoryRunState> {
    const pending = state.artifacts.pendingGuardCandidate;
    if (!pending || pending.candidateVersion !== version
      || violations.some((violation) => violation.code !== "raw_source_overlap_inconclusive")) {
      throw new Error("Corpus guard recheck requires only inconclusive findings for its pending candidate");
    }
    const report = await store.writeArtifact(
      `evaluations/corpus-release-guard-inconclusive-v${version}-${shortId()}.md`,
      [
        "# Deterministic Corpus release guard",
        "",
        "## Verdict",
        "INCONCLUSIVE",
        "",
        "## Diagnosis",
        ...violations.map((violation) => `- [${violation.code}] ${violation.detail}`),
        "",
        "## Operator action",
        "Retry this run to re-audit the same content-addressed compilation. Do not send this finding to the Corpus LLM as proof of raw overlap.",
        ""
      ].join("\n")
    );
    state.artifacts.pendingGuardCandidate = { ...pending, guardReport: report };
    state.stage = "needs_attention";
    state.retryStage = "compiling_corpus";
    state.lastError = "Corpus release guard analysis was inconclusive; retry will re-audit the same compilation without calling the Corpus LLM";
    await store.recordEvent("corpus_release_guard_inconclusive", {
      version,
      report,
      violations: violations.map(({ code, assetPath, sourceId }) => ({
        code,
        assetPath,
        ...(sourceId ? { sourceId } : {})
      })),
      nextStage: state.stage
    });
    return state;
  }

  /**
   * Upgrade a legacy draft only when its content-addressed host report proves
   * that the old matcher exhausted an allowlisted analysis budget. The legacy
   * FAIL itself is never trusted: the draft is parsed and fully re-audited by
   * the current guard before it can be accepted or sent to a repair LLM.
   */
  private async restoreLegacyInconclusiveGuardCandidate(
    store: FactoryFileStore,
    state: FactoryRunState
  ): Promise<void> {
    if (state.artifacts.pendingGuardCandidate) return;
    const target = state.artifacts.rejectedCorpusRepairTarget;
    if (!target || target.reason !== "release_guard") return;
    const nextVersion = state.artifacts.corpusCandidates.length + 1;
    if (target.candidateVersion !== nextVersion) return;
    if (!isLegacyGuardReportPath(target.failureReport.path, nextVersion)) return;
    const legacyReport = await store.readArtifact(target.failureReport);
    if (!isLegacyInconclusiveGuardReport(legacyReport)) return;
    // Verify the draft digest now. Parsing and the current full audit happen in
    // the ordinary pending-candidate branch below.
    await store.readArtifact(target.compilation);
    state.artifacts.pendingGuardCandidate = {
      candidateVersion: nextVersion,
      compilation: target.compilation,
      reason: state.compileReason!
    };
    await store.saveState(state);
    await store.recordEvent("legacy_inconclusive_guard_candidate_restored", {
      version: nextVersion,
      compilationSha256: target.compilation.sha256
    });
  }

  /**
   * States written before completeness failures became explicit repair
   * targets can contain a failed candidate and its audit report, but no
   * rejectedCorpusRepairTarget. Reconstruct that pointer from the immutable
   * candidate/report pair before asking the Corpus compiler to continue.
   */
  private async restoreLegacyCompletenessRepairTarget(
    store: FactoryFileStore,
    state: FactoryRunState
  ): Promise<void> {
    const candidate = state.artifacts.corpusCandidates.at(-1);
    if (!candidate || candidate.completeness !== "FAIL") return;
    const existing = state.artifacts.rejectedCorpusRepairTarget;
    if (existing
      && existing.candidateVersion === candidate.version
      && sameArtifact(existing.compilation, candidate.compileRecord)
      && existing.reason === "completeness_failure") {
      return;
    }
    const reportReference = [...state.artifacts.evaluationRounds].reverse().find((reference) => (
      new RegExp(`(?:^|/)corpus-completeness-v${candidate.version}-[^/]+\\.md$`).test(reference.path)
    ));
    if (!reportReference) {
      throw new Error(`Failed Corpus candidate v${candidate.version} is missing its completeness report`);
    }
    const report = parseEvaluation(await store.readArtifact(reportReference));
    if (report.pass) {
      throw new Error(`Failed Corpus candidate v${candidate.version} has a passing completeness report`);
    }
    await store.readArtifact(candidate.compileRecord);
    state.artifacts.rejectedCorpusRepairTarget = {
      attempt: existing?.candidateVersion === candidate.version ? existing.attempt : 1,
      candidateVersion: candidate.version,
      compilation: candidate.compileRecord,
      failureReport: reportReference,
      reason: "completeness_failure"
    };
    await store.saveState(state);
    await store.recordEvent("legacy_completeness_repair_target_restored", {
      version: candidate.version,
      compilationSha256: candidate.compileRecord.sha256,
      reportSha256: reportReference.sha256
    });
  }

  private async invalidateSupersededLegacyGuardReports(
    store: FactoryFileStore,
    state: FactoryRunState,
    version: number
  ): Promise<void> {
    const pending = state.artifacts.pendingGuardCandidate;
    const target = state.artifacts.rejectedCorpusRepairTarget;
    if (!pending || !target
      || target.candidateVersion !== version
      || !sameArtifact(target.compilation, pending.compilation)) return;

    const retained: ArtifactRef[] = [];
    const invalidated: ArtifactRef[] = [];
    for (const reference of state.artifacts.evaluationRounds) {
      if (!isLegacyGuardReportPath(reference.path, version)) {
        retained.push(reference);
        continue;
      }
      const report = await store.readArtifact(reference);
      if (isLegacyInconclusiveGuardReport(report)) invalidated.push(reference);
      else retained.push(reference);
    }
    if (invalidated.length === 0) return;
    state.artifacts.evaluationRounds = retained;
    // Persist invalidation before proceeding. The immutable report artifacts
    // remain available for audit, but no future Corpus prompt can consume the
    // superseded false/budget findings as active repair feedback.
    await store.saveState(state);
    await store.recordEvent("legacy_guard_reports_invalidated", {
      version,
      reports: invalidated.map(({ path: reportPath, sha256 }) => ({ path: reportPath, sha256 }))
    });
  }

  private async evaluateDevelopment(store: FactoryFileStore, state: FactoryRunState): Promise<FactoryRunState> {
    if (!state.artifacts.developmentQa) throw new Error("Development QA is missing");
    const evaluations = await this.evaluateQa(
      store,
      state,
      state.artifacts.developmentQa,
      `development-${state.artifacts.evaluationRounds.length + 1}`,
      false
    );
    const qa = evaluations.map((item) => item.qa);
    const report = await store.writeArtifact(
      `evaluations/development-${state.artifacts.evaluationRounds.length + 1}-${shortId()}.md`,
      renderEvaluationReport("Development evaluation", evaluations)
    );
    state.artifacts.evaluationRounds.push(report);
    state.calibrationFeedback = [report];
    state.developmentEvaluated = true;
    const failures = evaluations.filter((item) => !item.verdict.pass).map((item) => item.qa);
    // Development is calibration data, not a release gate by itself. Give its
    // complete Eval report back to Corpus even when the candidate passed, then
    // freeze every calibrated case into Regression so the revision cannot
    // silently lose behavior that already agreed with the Creator.
    state.artifacts.regressionSet = await this.mergeRegression(store, state.artifacts.regressionSet, qa);
    state.compileReason = failures.length > 0 ? "development_failure" : "development_calibration";
    state.stage = "compiling_corpus";
    await store.recordEvent("development_evaluated", {
      failures: failures.length,
      report,
      latestRegressionEvaluation: state.artifacts.latestRegressionEvaluation,
      nextStage: state.stage
    });
    state.activeQaEvaluation = undefined;
    await store.saveState(state);
    return state;
  }

  private async evaluateRegression(store: FactoryFileStore, state: FactoryRunState): Promise<FactoryRunState> {
    if (!state.artifacts.regressionSet) throw new Error("Regression evaluation has no Regression Set");
    const evaluations = await this.evaluateQa(
      store,
      state,
      state.artifacts.regressionSet,
      `regression-${state.artifacts.evaluationRounds.length + 1}`,
      false
    );
    const report = await store.writeArtifact(
      `evaluations/regression-${state.artifacts.evaluationRounds.length + 1}-${shortId()}.md`,
      renderEvaluationReport("Full Regression evaluation", evaluations)
    );
    state.artifacts.evaluationRounds.push(report);
    if (state.replacementHeldoutNeeded === 0) state.calibrationFeedback = [report];
    state.artifacts.latestRegressionEvaluation = await store.writeArtifact(
      `evaluations/regression-latest-${shortId()}.json`,
      renderEvaluationAsset("synthetic_qa", evaluations)
    );
    const failures = evaluations.filter((item) => !item.verdict.pass);
    if (failures.length > 0) {
      state.compileReason = state.replacementHeldoutNeeded > 0 ? "heldout_failure" : "development_failure";
      state.stage = "compiling_corpus";
    } else if (state.replacementHeldoutNeeded > 0) {
      state = await this.requestReplacementHeldout(store, state);
    } else {
      state.stage = "evaluating_heldout";
    }
    await store.recordEvent("regression_evaluated", {
      failures: failures.length,
      report,
      latestRegressionEvaluation: state.artifacts.latestRegressionEvaluation,
      nextStage: state.stage
    });
    state.activeQaEvaluation = undefined;
    await store.saveState(state);
    return state;
  }

  private async evaluateHeldout(store: FactoryFileStore, state: FactoryRunState): Promise<FactoryRunState> {
    const heldoutRef = state.artifacts.heldoutRounds.at(-1);
    if (!heldoutRef) throw new Error("Held-out evaluation has no sealed Held-out Set");
    const round = state.artifacts.heldoutRounds.length;
    const evaluations = await this.evaluateQa(store, state, heldoutRef, `heldout-${round}`, true);
    const sealedReport = await store.writeArtifact(
      `evaluations/heldout-round-${round}-${shortId()}.md`,
      renderEvaluationReport(`Held-out evaluation round ${round}`, evaluations),
      true
    );
    state.artifacts.latestHeldoutEvaluation = await store.writeArtifact(
      `evaluations/heldout-latest-${shortId()}.json`,
      renderEvaluationAsset("held_out", evaluations),
      true
    );
    const failures = evaluations.filter((item) => !item.verdict.pass).map((item) => item.qa);
    if (failures.length > 0) {
      // Held-out is sealed evaluation data. A blind failure must pause for an
      // explicit Creator correction before it can enter the Known/Regression
      // set; silently promoting it would turn the blind set into development.
      state.artifacts.evaluationRounds.push(sealedReport);
      state.pendingReview = {
        kind: "heldout_failure",
        // Review promotion consumes the sealed machine-readable evaluation
        // asset; the human report remains in evaluationRounds for audit.
        report: state.artifacts.latestHeldoutEvaluation!,
        failedCount: failures.length
      };
      state.stage = "review_required";
    } else {
      const latest = state.artifacts.corpusCandidates.at(-1);
      if (!latest) throw new Error("Held-out passed without a Corpus candidate");
      if (!state.artifacts.latestRegressionEvaluation || !state.artifacts.latestHeldoutEvaluation) {
        throw new Error("Held-out passed without complete Regression and Held-out evaluation assets");
      }
      const candidateRoot = candidateCorpusRoot(latest.systemInstructions.path);
      const materialized = await materializeAgentCorpusBundle(store, {
        candidateRoot,
        creator: state.creator,
        agentId: state.agentId,
        product: state.product,
        systemInstructions: await store.readArtifact(latest.systemInstructions),
        ...await this.cognitiveBundleInputs(store, state, latest),
        tools: factoryTools(state),
        syntheticQa: JSON.parse(await store.readArtifact(state.artifacts.latestRegressionEvaluation)),
        heldOut: JSON.parse(await store.readArtifact(state.artifacts.latestHeldoutEvaluation))
      });
      latest.systemInstructions = materialized.assets.system;
      latest.agentCorpus = {
        rootPath: materialized.bundleRoot,
        manifest: materialized.manifestRef,
        assets: {
          system: materialized.assets.system,
          skills: materialized.assets.skills,
          knowledge: materialized.assets.knowledge
        },
        syntheticQa: materialized.assets.syntheticQa,
        heldOut: materialized.assets.heldOut,
        digest: materialized.digest,
        verifiedAt: new Date().toISOString()
      };
      state.stage = "ready";
      await store.writeCandidate("READY.md", [
        "# Creator Factory candidate ready",
        "",
        `Run: ${state.runId}`,
        `Creator: ${state.creator.name}`,
        `Agent: ${state.agentId}`,
        `Product: ${state.product.name}`,
        `Product: ${state.productName}`,
        `Corpus version: ${latest.version}`,
        `System instructions digest: ${latest.systemInstructions.sha256}`,
        `Verified Agent Corpus digest: ${latest.agentCorpus.digest}`,
        `Bundle root: ${latest.agentCorpus.rootPath}`,
        `Held-out round: ${round}`,
        "",
        "This revision is Release-ready. Release combines Creator approval and Registry publication."
      ].join("\n"));
    }
    await store.recordEvent("heldout_evaluated", {
      round,
      failures: failures.length,
      sealedReport,
      latestHeldoutEvaluation: state.artifacts.latestHeldoutEvaluation,
      nextStage: state.stage
    });
    state.activeQaEvaluation = undefined;
    await store.saveState(state);
    return state;
  }

  private async requestReplacementHeldout(store: FactoryFileStore, state: FactoryRunState): Promise<FactoryRunState> {
    const excluded = await this.allPastQuestions(store, state);
    const prefix = `H${state.artifacts.heldoutRounds.length + 1}`;
    const questions = await this.generateQuestions(store, state, state.replacementHeldoutNeeded, prefix, excluded);
    const questionBatch = issueQuestionBatch(
      state.runId,
      await store.writeArtifact(
        `question-batches/replacement-${prefix}.md`,
        renderQuestionBatch(`Replacement held-out questions ${prefix}`, questions),
        true
      )
    );
    const creatorAnswerTemplate = await store.writeArtifact(
      `creator/replacement-${prefix}-answer-template.md`,
      renderCreatorAnswerTemplate(questions, questionBatch.batchId),
      true
    );
    state.artifacts.currentQuestionBatch = questionBatch;
    state.artifacts.creatorAnswerTemplate = creatorAnswerTemplate;
    state.pendingQuestionBatch = { purpose: "replacement_heldout", count: questions.length };
    state.stage = "awaiting_creator_answers";
    await store.recordEvent("creator_answers_requested", { purpose: "replacement_heldout", count: questions.length });
    return state;
  }

  private async generateQuestions(
    store: FactoryFileStore,
    state: Pick<FactoryRunState, "creator" | "productName" | "artifacts">,
    count: number,
    idPrefix: string,
    excludedQuestions: CreatorQuestion[] = []
  ): Promise<CreatorQuestion[]> {
    try {
      if (!state.artifacts.evidence) throw new Error("Question generation requires Evidence");
      const call = questionPrompt({
        creatorName: state.creator.name,
        productName: state.productName,
        productPromise: await store.readArtifact(state.artifacts.productPromise),
        evidence: await store.readArtifact(state.artifacts.evidence),
        count,
        excludedQuestions
      });
      const raw = await this.call(
        store,
        {
          purpose: "eval.generate_questions",
          outputContract: { kind: "question_set", expectedCount: count },
          ...call
        },
        `questions-${idPrefix}`,
        true
      );
      const parsed = parseQuestions(raw);
      if (parsed.length !== count) throw new Error(`Eval LLM returned ${parsed.length} questions; expected ${count}`);
      const seen = new Set<string>();
      const excluded = new Set(excludedQuestions.map((question) => normalizedQuestion(question.question)));
      const excludedLeakageGroups = new Set(
        excludedQuestions.map((question) => question.leakageGroup?.trim()).filter((group): group is string => !!group)
      );
      return parsed.map((question, index) => {
        const normalized = normalizedQuestion(question.question);
        if (seen.has(normalized)) throw new Error(`Eval LLM repeated question ${question.id}`);
        if (excluded.has(normalized)) throw new Error(`Eval LLM reused excluded question ${question.id}`);
        const leakageGroup = question.leakageGroup?.trim();
        if (!leakageGroup) throw new Error(`Eval LLM question ${question.id} has no leakage group`);
        if (excludedLeakageGroups.has(leakageGroup)) {
          throw new Error(`Eval LLM reused excluded leakage group ${leakageGroup}`);
        }
        seen.add(normalized);
        return { ...question, kind: question.kind ?? "behavior", leakageGroup, id: `${idPrefix}.Q${index + 1}` };
      });
    } catch (error) {
      throw sealedFactoryFailure(error);
    }
  }

  private async evaluateQa(
    store: FactoryFileStore,
    state: FactoryRunState,
    qaReference: ArtifactRef,
    label: string,
    sealed: boolean
  ): Promise<QaEvaluation[]> {
    if ((qaReference.sealed === true) !== sealed) {
      throw new Error(`QA evaluation seal does not match its ArtifactRef for ${label}`);
    }
    const qa = parseQaSet(await store.readArtifact(qaReference));
    const candidate = state.artifacts.corpusCandidates.at(-1);
    if (!candidate) throw new Error("QA evaluation requires a Corpus candidate");
    await this.materializeEvaluationCandidate(store, state, candidate);
    if (!candidate.agentCorpus) throw new Error("QA evaluation requires a verified Agent Corpus candidate");
    const corpus = await store.readArtifact(candidate.systemInstructions);
    const expectedScope = qaEvaluationScope(
      label,
      qaReference,
      qa,
      candidate.version,
      candidate.agentCorpus.digest,
      sealed
    );
    if (!sameQaEvaluationScope(state.activeQaEvaluation, expectedScope)) {
      state.activeQaEvaluation = expectedScope;
      await store.saveState(state);
    }
    const scope = state.activeQaEvaluation!;
    const results: QaEvaluation[] = [];
    for (let index = 0; index < qa.length; index += 1) {
      const item = qa[index]!;
      const checkpoint = scope.cases[index]!;
      const binding = qaCaseBinding(scope, index);
      let hatchArtifact = checkpoint.hatchResult;
      let hatchResult: string | undefined;
      if (hatchArtifact) {
        assertCheckpointReferenceSeal(hatchArtifact, sealed, "Hatch");
        const payload = parseHatchCheckpoint(await store.readArtifact(hatchArtifact));
        if (sameQaCaseBinding(payload.binding, binding)) {
          hatchResult = payload.hatchResult;
        } else {
          checkpoint.hatchResult = undefined;
          checkpoint.evaluation = undefined;
          hatchArtifact = undefined;
          await store.saveState(state);
        }
      }
      if (hatchResult === undefined) {
        hatchResult = await this.executeHatchCandidate(
          store,
          {
            runId: state.runId,
            corpusVersion: candidate.version,
            agentCorpusRoot: path.join(store.directory, ...candidate.agentCorpus.rootPath.split("/")),
            creatorId: state.creator.id,
            agentId: state.agentId,
            corpusDigest: candidate.agentCorpus.digest,
            systemInstructions: corpus,
            question: item.question
          },
          `${label}-${item.id}-hatch`,
          sealed
        );
        const payload = renderHatchCheckpoint(binding, hatchResult);
        hatchArtifact = await store.writeArtifact(
          checkpointArtifactPath(label, index, checkpoint.canonicalDigest, "hatch"),
          `${JSON.stringify(payload, null, 2)}\n`,
          sealed
        );
        checkpoint.hatchResult = hatchArtifact;
        checkpoint.evaluation = undefined;
        await store.saveState(state);
      }

      let verdict: QaEvaluation["verdict"] | undefined;
      if (checkpoint.evaluation) {
        assertCheckpointReferenceSeal(checkpoint.evaluation, sealed, "Eval");
        const payload = parseEvalCheckpoint(await store.readArtifact(checkpoint.evaluation));
        if (
          sameQaCaseBinding(payload.binding, binding)
          && payload.hatchCheckpointSha256 === hatchArtifact!.sha256
        ) {
          verdict = parseEvaluation(payload.rawVerdict);
        } else {
          checkpoint.evaluation = undefined;
          await store.saveState(state);
        }
      }
      if (!verdict) {
        const judge = evaluationPrompt({
          creatorName: state.creator.name,
          productName: state.productName,
          qa: item,
          hatchResult
        });
        const rawVerdict = await this.call(
          store,
          {
            purpose: "eval.judge_result",
            outputContract: { kind: "evaluation_verdict" },
            ...judge
          },
          `${label}-${item.id}-eval`,
          sealed
        );
        verdict = parseEvaluation(rawVerdict);
        const payload = renderEvalCheckpoint(binding, hatchArtifact!.sha256, rawVerdict);
        checkpoint.evaluation = await store.writeArtifact(
          checkpointArtifactPath(label, index, checkpoint.canonicalDigest, "eval"),
          `${JSON.stringify(payload, null, 2)}\n`,
          sealed
        );
        await store.saveState(state);
      }
      results.push({ qa: item, hatchResult, verdict });
    }
    return results;
  }

  /**
   * Every Development, Regression, and Held-out execution must bind the real
   * Hatch Runtime to a complete, verifier-approved Agent Corpus. Evaluation
   * assets remain eval-only: Hatch's live materializer never injects them into
   * the candidate context, and the Corpus LLM is never given this bundle.
   */
  private async materializeEvaluationCandidate(
    store: FactoryFileStore,
    state: FactoryRunState,
    candidate: FactoryRunState["artifacts"]["corpusCandidates"][number]
  ): Promise<void> {
    if (!state.artifacts.developmentQa) throw new Error("Candidate staging requires Development QA");
    const regressionOrDevelopment = state.artifacts.regressionSet
      ? parseQaSet(await store.readArtifact(state.artifacts.regressionSet))
      : parseQaSet(await store.readArtifact(state.artifacts.developmentQa));
    const activeHeldout = state.artifacts.heldoutRounds.at(-1);
    if (!activeHeldout?.sealed) throw new Error("Candidate staging requires a sealed Held-out Set");
    const materialized = await materializeAgentCorpusBundle(store, {
      candidateRoot: candidateCorpusRoot(candidate.systemInstructions.path),
      creator: state.creator,
      agentId: state.agentId,
      product: state.product,
      systemInstructions: await store.readArtifact(candidate.systemInstructions),
      ...await this.cognitiveBundleInputs(store, state, candidate),
      tools: factoryTools(state),
      syntheticQa: referenceEvaluationAsset("synthetic_qa", regressionOrDevelopment),
      // Agent Corpus requires a held_out asset even while Factory is using the
      // candidate to execute Development, Regression, and the active Held-out
      // gate. Never satisfy that structural requirement with the active
      // sealed set: doing so would copy its Questions, Creator answers, and a
      // content-derived digest into an unsealed candidate tree before PASS.
      // This host-authored empty document is replaced with the complete
      // canonical evaluation only in evaluateHeldout's PASS branch.
      heldOut: provisionalHeldoutEvaluationAsset()
    });
    candidate.systemInstructions = materialized.assets.system;
    candidate.agentCorpus = {
      rootPath: materialized.bundleRoot,
      manifest: materialized.manifestRef,
      assets: {
        system: materialized.assets.system,
        skills: materialized.assets.skills,
        knowledge: materialized.assets.knowledge
      },
      syntheticQa: materialized.assets.syntheticQa,
      heldOut: materialized.assets.heldOut,
      digest: materialized.digest,
      verifiedAt: new Date().toISOString()
    };
  }

  /** Reparse the immutable full compiler record so resume never depends on an
   * in-memory asset plan and every optional layer reaches the canonical bundle. */
  private async cognitiveBundleInputs(
    store: FactoryFileStore,
    state: FactoryRunState,
    candidate: FactoryRunState["artifacts"]["corpusCandidates"][number]
  ): Promise<Pick<Parameters<typeof materializeAgentCorpusBundle>[1], "skills" | "knowledge">> {
    const compilation = parseCorpusCompilation(await store.readArtifact(candidate.compileRecord), {
      availableToolIds: factoryTools(state).map((tool) => tool.id)
    });
    const referencesBySkill = new Map<string, typeof compilation.references>();
    for (const reference of compilation.references) {
      referencesBySkill.set(reference.parentSkillId, [
        ...(referencesBySkill.get(reference.parentSkillId) ?? []),
        reference
      ]);
    }
    return {
      skills: compilation.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        whenToUse: skill.whenToUse,
        instruction: skill.content,
        allowedToolIds: skill.allowedToolIds,
        references: (referencesBySkill.get(skill.id) ?? []).map((reference) => ({
          id: reference.id,
          kind: reference.kind,
          content: reference.content
        }))
      })),
      knowledge: compilation.knowledge.map((document) => ({
        id: document.id,
        content: document.content,
        sourceSummary: document.sourceSummary
      }))
    };
  }

  private async mergeRegression(
    store: FactoryFileStore,
    current: ArtifactRef | undefined,
    additions: CreatorQa[]
  ): Promise<ArtifactRef> {
    const rows = current ? parseQaSet(await store.readArtifact(current)) : [];
    const merged = new Map(rows.map((item) => [item.id, item]));
    for (const item of additions) merged.set(item.id, item);
    const previousVersion = current ? Number(/regression-v(\d+)\.md$/.exec(current.path)?.[1] ?? 0) : 0;
    return store.writeArtifact(
      `qa/regression-v${previousVersion + 1}.md`,
      renderQaSet(`Regression Set v${previousVersion + 1}`, [...merged.values()])
    );
  }

  private async allPastQuestions(store: FactoryFileStore, state: FactoryRunState): Promise<CreatorQuestion[]> {
    const rows: CreatorQuestion[] = [];
    if (state.artifacts.developmentQa) rows.push(...parseQaSet(await store.readArtifact(state.artifacts.developmentQa)));
    for (const reference of state.artifacts.heldoutRounds) rows.push(...parseQaSet(await store.readArtifact(reference)));
    return rows.map(({ id, question, intent, leakageGroup, kind }) => ({
      id,
      question,
      ...(intent ? { intent } : {}),
      ...(leakageGroup ? { leakageGroup } : {}),
      ...(kind ? { kind } : {})
    }));
  }

  private async call(
    store: FactoryFileStore,
    call: FactoryPromptCall,
    label: string,
    sealed: boolean
  ): Promise<string> {
    const clock = this.executionClock();
    const timing = await store.beginExecution({
      startedAt: clock.wallNow().toISOString(),
      sealed,
      metadata: {
        boundary: "factory_llm",
        purpose: call.purpose,
        promptVersion: PROMPT_VERSION,
        provider: this.options.model?.provider ?? "unspecified",
        model: this.options.model?.model ?? "unspecified"
      }
    });
    const monotonicStart = clock.monotonicNow();
    let output: string;
    let failureTelemetry: Parameters<NonNullable<FactoryPromptCall["reportFailureTelemetry"]>>[0] | undefined;
    try {
      output = await this.runPrompt({
        ...call,
        reportFailureTelemetry: (telemetry) => {
          failureTelemetry = structuredClone(telemetry);
          call.reportFailureTelemetry?.(telemetry);
        },
        ...(store.signal ? { signal: store.signal } : {})
      });
      await store.settleExecution(timing, {
        status: "completed",
        completedAt: clock.wallNow().toISOString(),
        elapsedMs: monotonicElapsed(monotonicStart, clock.monotonicNow())
      });
    } catch (error) {
      try {
        await this.settleFailedExecution(store, timing, monotonicStart, error, failureTelemetry);
      } catch (settlementError) {
        throw sealed ? sealedFactoryFailure(settlementError) : settlementError;
      }
      throw sealed ? sealedFactoryFailure(error) : error;
    }
    try {
      const trace = await store.writeArtifact(
        `traces/${safeLabel(label)}-${shortId()}.md`,
        [
          `# ${call.purpose}`,
          "",
          `Prompt version: ${PROMPT_VERSION}`,
          `Provider: ${this.options.model?.provider ?? "unspecified"}`,
          `Model: ${this.options.model?.model ?? "unspecified"}`,
          "",
          "## System prompt",
          "",
          call.systemPrompt,
          "",
          "## Dynamic prompt",
          "",
          call.prompt,
          "",
          "## Output",
          "",
          output,
          ""
        ].join("\n"),
        sealed
      );
      await store.recordEvent("llm_call_completed", {
        purpose: call.purpose,
        promptVersion: PROMPT_VERSION,
        provider: this.options.model?.provider ?? "unspecified",
        model: this.options.model?.model ?? "unspecified",
        trace: trace.path,
        traceDigest: trace.sha256,
        sealed
      });
      return output;
    } catch (error) {
      throw sealed ? sealedFactoryFailure(error) : error;
    }
  }

  private async executeHatchCandidate(
    store: FactoryFileStore,
    execution: Parameters<HatchCandidateExecutor>[0],
    label: string,
    sealed: boolean
  ): Promise<string> {
    const clock = this.executionClock();
    const timing = await store.beginExecution({
      startedAt: clock.wallNow().toISOString(),
      sealed,
      metadata: {
        boundary: "hatch_product_runtime",
        purpose: "hatch.candidate",
        corpusVersion: execution.corpusVersion,
        corpusDigest: execution.corpusDigest
      }
    });
    const monotonicStart = clock.monotonicNow();
    let result: HatchCandidateResult;
    let output: string;
    try {
      const executed = await this.executeCandidate({ ...execution, ...(store.signal ? { signal: store.signal } : {}) });
      result = typeof executed === "string"
        ? { output: executed, corpusDigest: execution.corpusDigest }
        : executed;
      if (result.corpusDigest !== execution.corpusDigest) {
        throw new Error("Hatch candidate executor returned a mismatched Agent Corpus digest");
      }
      output = result.output;
      if (!output.trim()) throw new Error("Hatch candidate executor returned an empty result");
      await store.settleExecution(timing, {
        status: "completed",
        completedAt: clock.wallNow().toISOString(),
        elapsedMs: monotonicElapsed(monotonicStart, clock.monotonicNow())
      });
    } catch (error) {
      try {
        await this.settleFailedExecution(store, timing, monotonicStart, error);
      } catch (settlementError) {
        throw sealed ? sealedFactoryFailure(settlementError) : settlementError;
      }
      throw sealed ? sealedFactoryFailure(error) : error;
    }
    const trace = await store.writeArtifact(
      `traces/${safeLabel(label)}-${shortId()}.md`,
      [
        "# Hatch candidate execution",
        "",
        `Corpus version: ${execution.corpusVersion}`,
        `Verified Agent Corpus digest: ${execution.corpusDigest}`,
        "Execution boundary: Hatch product Runtime (provider and model are owned by Runtime, not Creator Factory)",
        ...(result.runtimeRunId ? [`Runtime run: ${result.runtimeRunId}`] : []),
        ...(result.finishReason ? [`Finish reason: ${result.finishReason}`] : []),
        ...(result.terminalStatus ? [`Terminal status: ${result.terminalStatus}`] : []),
        ...(result.protocolEvents ? [
          `Protocol trace${result.protocolTraceTruncated ? " (truncated)" : ""}: ${JSON.stringify(result.protocolEvents)}`
        ] : []),
        "",
        "## System instructions",
        "",
        execution.systemInstructions,
        "",
        "## Question",
        "",
        execution.question,
        "",
        "## Hatch result",
        "",
        output,
        ""
      ].join("\n"),
      sealed
    );
    await store.recordEvent("hatch_candidate_executed", {
      corpusVersion: execution.corpusVersion,
      corpusDigest: execution.corpusDigest,
      executionBoundary: "hatch_product_runtime",
      ...(result.runtimeRunId ? { runtimeRunId: result.runtimeRunId } : {}),
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      ...(result.terminalStatus ? { terminalStatus: result.terminalStatus } : {}),
      protocolTraceTruncated: result.protocolTraceTruncated ?? false,
      trace: trace.path,
      traceDigest: trace.sha256,
      sealed
    });
    return output;
  }

  private executionClock(): NonNullable<CreatorFactoryOptions["timingClock"]> {
    return this.options.timingClock ?? {
      wallNow: () => new Date(),
      monotonicNow: () => performance.now()
    };
  }

  private fileStore(runId: string | undefined, control: FactoryExecutionControl = {}, graphContext?: { productId?: string; runId?: string; revisionId?: string }): FactoryFileStore {
    return new FactoryFileStore(this.root, runId, control.beforeCommit, control.signal, {
      objectStore: this.options.objectStore,
      graphStore: this.options.graphStore,
      ...(graphContext ? { graphContext } : {})
    });
  }

  private async settleFailedExecution(
    store: FactoryFileStore,
    timing: Awaited<ReturnType<FactoryFileStore["beginExecution"]>>,
    monotonicStart: number,
    error: unknown,
    failureTelemetry?: Parameters<NonNullable<FactoryPromptCall["reportFailureTelemetry"]>>[0]
  ): Promise<void> {
    const clock = this.executionClock();
    const settlement = {
      status: store.signal?.aborted || isAbortError(error) ? "aborted" as const : "failed" as const,
      completedAt: clock.wallNow().toISOString(),
      elapsedMs: monotonicElapsed(monotonicStart, clock.monotonicNow())
    };
    try {
      await store.settleExecution(timing, {
        ...settlement,
        ...(failureTelemetry ? { failureTelemetry } : {})
      });
    } catch (settlementError) {
      // Failure telemetry is diagnostic only. If its strict schema rejects a
      // producer bug, preserve the real execution failure and settle without
      // telemetry instead of leaving a false `running` record.
      const message = settlementError instanceof Error ? settlementError.message : String(settlementError);
      if (!failureTelemetry || !/^Invalid Factory (?:failure telemetry|last tool-turn telemetry)/.test(message)) {
        throw settlementError;
      }
      await store.settleExecution(timing, settlement);
    }
  }

  private async needsAttention(
    store: FactoryFileStore,
    state: FactoryRunState,
    error: unknown
  ): Promise<FactoryRunState> {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const providerFailure = classifyFactoryProviderFailure(error);
    // Provider/runtime errors can echo their input. A held-out failure must not
    // declassify Question, Creator answer, or result through state.json or the
    // unsealed diagnostic journal.
    const message = isSealedFactoryFailure(error) || state.activeQaEvaluation?.sealed
      ? SEALED_FAILURE_MESSAGE
      : providerFailure?.message ?? rawMessage;
    const terminal = /did not converge after|workflow step limit/i.test(rawMessage);
    const retryStage = terminal || state.stage === "ready" || state.stage === "needs_attention" || state.stage === "awaiting_creator_answers"
      ? undefined
      : state.stage;
    const next = {
      ...state,
      stage: "needs_attention" as const,
      ...(retryStage ? { retryStage } : {}),
      lastError: message
    };
    await store.saveState(next);
    await store.recordEvent("factory_needs_attention", { error: message });
    return store.loadState();
  }
}

type AcceptedCorpusHistoryEntry = {
  version: number;
  raw: string;
  compilation: ReturnType<typeof parseCorpusCompilation>;
};

/**
 * Continuity is anchored only in candidates that passed the independent
 * completeness audit. A failed attempt remains useful as feedback, but it is
 * neither the next compiler predecessor nor a preservation baseline.
 *
 * `completeness` was added after durable Factory runs already existed. For
 * those states, the content-addressed completeness report is the recovery
 * truth; a materialized Agent Corpus is an additional unambiguous proof that
 * the candidate passed this gate before evaluation began.
 */
async function acceptedCorpusHistory(
  store: FactoryFileStore,
  state: FactoryRunState,
  availableToolIds: string[]
): Promise<AcceptedCorpusHistoryEntry[]> {
  const legacyVerdicts = new Map<number, "PASS" | "FAIL">();
  for (const reference of state.artifacts.evaluationRounds) {
    const match = /(?:^|\/)corpus-completeness-v(\d+)-[^/]+\.md$/.exec(reference.path);
    if (!match) continue;
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version < 1) continue;
    const verdict = parseEvaluation(await store.readArtifact(reference));
    legacyVerdicts.set(version, verdict.pass ? "PASS" : "FAIL");
  }

  const accepted: AcceptedCorpusHistoryEntry[] = [];
  for (const candidate of [...state.artifacts.corpusCandidates].sort((left, right) => left.version - right.version)) {
    const completeness = candidate.completeness
      ?? legacyVerdicts.get(candidate.version)
      ?? (candidate.agentCorpus ? "PASS" : undefined);
    if (completeness !== "PASS") continue;
    const raw = await store.readArtifact(candidate.compileRecord);
    accepted.push({
      version: candidate.version,
      raw,
      compilation: parseCorpusCompilation(raw, { availableToolIds })
    });
  }
  return accepted;
}

class SealedFactoryFailure extends Error {
  readonly sealed = true;

  constructor(cause: unknown) {
    super(SEALED_FAILURE_MESSAGE, { cause });
    this.name = "SealedFactoryFailure";
  }
}

function sealedFactoryFailure(error: unknown): SealedFactoryFailure {
  return error instanceof SealedFactoryFailure ? error : new SealedFactoryFailure(error);
}

function isSealedFactoryFailure(error: unknown): error is SealedFactoryFailure {
  return error instanceof SealedFactoryFailure;
}

function monotonicElapsed(start: number, end: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error("Factory execution monotonic clock returned a non-finite value");
  }
  // The production clock is monotonic. Clamp a broken/injected clock rather
  // than ever emitting a negative duration that could be mistaken for a wall
  // clock calculation.
  return Math.max(0, end - start);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

type QaCaseBinding = {
  label: string;
  qaSetSha256: string;
  qaOrderSha256: string;
  caseIndex: number;
  caseCanonicalDigest: string;
  corpusVersion: number;
  corpusDigest: string;
  sealed: boolean;
};

type HatchCheckpointPayload = {
  contractVersion: "1";
  kind: "hatch_candidate_result";
  binding: QaCaseBinding;
  hatchResultSha256: string;
  hatchResult: string;
};

type EvalCheckpointPayload = {
  contractVersion: "1";
  kind: "eval_result";
  binding: QaCaseBinding;
  hatchCheckpointSha256: string;
  rawVerdictSha256: string;
  rawVerdict: string;
};

function qaEvaluationScope(
  label: string,
  qaReference: ArtifactRef,
  qa: CreatorQa[],
  corpusVersion: number,
  corpusDigest: string,
  sealed: boolean
): ActiveQaEvaluationScope {
  const caseOrder = qa.map(canonicalQaDigest);
  return {
    contractVersion: "1",
    label,
    qaSetSha256: qaReference.sha256,
    caseOrder,
    corpusVersion,
    corpusDigest,
    sealed,
    cases: caseOrder.map((canonicalDigest) => ({ canonicalDigest }))
  };
}

function sameQaEvaluationScope(
  actual: ActiveQaEvaluationScope | undefined,
  expected: ActiveQaEvaluationScope
): boolean {
  return !!actual
    && actual.contractVersion === "1"
    && actual.label === expected.label
    && actual.qaSetSha256 === expected.qaSetSha256
    && actual.corpusVersion === expected.corpusVersion
    && actual.corpusDigest === expected.corpusDigest
    && actual.sealed === expected.sealed
    && Array.isArray(actual.caseOrder)
    && actual.caseOrder.length === expected.caseOrder.length
    && actual.caseOrder.every((digest, index) => digest === expected.caseOrder[index])
    && Array.isArray(actual.cases)
    && actual.cases.length === expected.cases.length
    && actual.cases.every((checkpoint, index) => (
      !!checkpoint
      && checkpoint.canonicalDigest === expected.cases[index]!.canonicalDigest
    ));
}

function canonicalQaDigest(qa: CreatorQa): string {
  return sha256Text(JSON.stringify({
    id: qa.id,
    question: qa.question,
    intent: qa.intent ?? null,
    leakageGroup: qa.leakageGroup ?? null,
    answer: qa.answer
  }));
}

function qaCaseBinding(scope: ActiveQaEvaluationScope, caseIndex: number): QaCaseBinding {
  const checkpoint = scope.cases[caseIndex];
  if (!checkpoint) throw new Error(`QA checkpoint case ${caseIndex} is outside the active scope`);
  return {
    label: scope.label,
    qaSetSha256: scope.qaSetSha256,
    qaOrderSha256: sha256Text(JSON.stringify(scope.caseOrder)),
    caseIndex,
    caseCanonicalDigest: checkpoint.canonicalDigest,
    corpusVersion: scope.corpusVersion,
    corpusDigest: scope.corpusDigest,
    sealed: scope.sealed
  };
}

function sameQaCaseBinding(actual: QaCaseBinding, expected: QaCaseBinding): boolean {
  return actual.label === expected.label
    && actual.qaSetSha256 === expected.qaSetSha256
    && actual.qaOrderSha256 === expected.qaOrderSha256
    && actual.caseIndex === expected.caseIndex
    && actual.caseCanonicalDigest === expected.caseCanonicalDigest
    && actual.corpusVersion === expected.corpusVersion
    && actual.corpusDigest === expected.corpusDigest
    && actual.sealed === expected.sealed;
}

function renderHatchCheckpoint(binding: QaCaseBinding, hatchResult: string): HatchCheckpointPayload {
  return {
    contractVersion: "1",
    kind: "hatch_candidate_result",
    binding,
    hatchResultSha256: sha256Text(hatchResult),
    hatchResult
  };
}

function renderEvalCheckpoint(
  binding: QaCaseBinding,
  hatchCheckpointSha256: string,
  rawVerdict: string
): EvalCheckpointPayload {
  return {
    contractVersion: "1",
    kind: "eval_result",
    binding,
    hatchCheckpointSha256,
    rawVerdictSha256: sha256Text(rawVerdict),
    rawVerdict
  };
}

function parseHatchCheckpoint(raw: string): HatchCheckpointPayload {
  const row = parseCheckpointObject(raw, "Hatch");
  requireExactKeys(row, ["contractVersion", "kind", "binding", "hatchResultSha256", "hatchResult"], "Hatch checkpoint");
  if (
    row.contractVersion !== "1"
    || row.kind !== "hatch_candidate_result"
    || typeof row.hatchResult !== "string"
    || !row.hatchResult.trim()
  ) {
    throw new Error("Referenced Hatch checkpoint has an invalid contract");
  }
  const binding = parseQaCaseBinding(row.binding, "Hatch");
  const hatchResultSha256 = requireSha256(row.hatchResultSha256, "Hatch result");
  if (sha256Text(row.hatchResult) !== hatchResultSha256) {
    throw new Error("Referenced Hatch checkpoint result digest mismatch");
  }
  return {
    contractVersion: "1",
    kind: "hatch_candidate_result",
    binding,
    hatchResultSha256,
    hatchResult: row.hatchResult
  };
}

function parseEvalCheckpoint(raw: string): EvalCheckpointPayload {
  const row = parseCheckpointObject(raw, "Eval");
  requireExactKeys(
    row,
    ["contractVersion", "kind", "binding", "hatchCheckpointSha256", "rawVerdictSha256", "rawVerdict"],
    "Eval checkpoint"
  );
  if (
    row.contractVersion !== "1"
    || row.kind !== "eval_result"
    || typeof row.rawVerdict !== "string"
    || !row.rawVerdict.trim()
  ) {
    throw new Error("Referenced Eval checkpoint has an invalid contract");
  }
  const binding = parseQaCaseBinding(row.binding, "Eval");
  const hatchCheckpointSha256 = requireSha256(row.hatchCheckpointSha256, "Eval Hatch checkpoint");
  const rawVerdictSha256 = requireSha256(row.rawVerdictSha256, "Eval verdict");
  if (sha256Text(row.rawVerdict) !== rawVerdictSha256) {
    throw new Error("Referenced Eval checkpoint verdict digest mismatch");
  }
  return {
    contractVersion: "1",
    kind: "eval_result",
    binding,
    hatchCheckpointSha256,
    rawVerdictSha256,
    rawVerdict: row.rawVerdict
  };
}

function parseQaCaseBinding(value: unknown, label: string): QaCaseBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Referenced ${label} checkpoint has an invalid binding`);
  }
  const row = value as Record<string, unknown>;
  requireExactKeys(row, [
    "label",
    "qaSetSha256",
    "qaOrderSha256",
    "caseIndex",
    "caseCanonicalDigest",
    "corpusVersion",
    "corpusDigest",
    "sealed"
  ], `${label} checkpoint binding`);
  if (
    typeof row.label !== "string"
    || !row.label
    || !Number.isInteger(row.caseIndex)
    || Number(row.caseIndex) < 0
    || !Number.isInteger(row.corpusVersion)
    || Number(row.corpusVersion) < 1
    || typeof row.sealed !== "boolean"
  ) {
    throw new Error(`Referenced ${label} checkpoint has an invalid binding`);
  }
  return {
    label: row.label,
    qaSetSha256: requireSha256(row.qaSetSha256, `${label} QA set`),
    qaOrderSha256: requireSha256(row.qaOrderSha256, `${label} QA order`),
    caseIndex: Number(row.caseIndex),
    caseCanonicalDigest: requireSha256(row.caseCanonicalDigest, `${label} QA case`),
    corpusVersion: Number(row.corpusVersion),
    corpusDigest: requireSha256(row.corpusDigest, `${label} Corpus`),
    sealed: row.sealed
  };
}

function parseCheckpointObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Referenced ${label} checkpoint is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Referenced ${label} checkpoint is not an object`);
  }
  return parsed as Record<string, unknown>;
}

function requireExactKeys(row: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Referenced ${label} has unexpected fields`);
  }
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Referenced ${label} digest is invalid`);
  }
  return value;
}

function assertCheckpointReferenceSeal(reference: ArtifactRef, sealed: boolean, label: string): void {
  const expectedPrefix = sealed ? "sealed/checkpoints/" : "artifacts/checkpoints/";
  if ((reference.sealed === true) !== sealed || !reference.path.startsWith(expectedPrefix)) {
    throw new Error(`Referenced ${label} checkpoint seal or namespace mismatch`);
  }
}

function checkpointArtifactPath(
  label: string,
  caseIndex: number,
  canonicalDigest: string,
  phase: "hatch" | "eval"
): string {
  const digestSuffix = canonicalDigest.replace(/^sha256:/, "").slice(0, 16);
  return `checkpoints/${safeLabel(label)}/${String(caseIndex + 1).padStart(4, "0")}-${digestSuffix}-${phase}-${shortId()}.json`;
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function renderSourcePacket(sources: FactoryStartInput["sources"]): string {
  return [
    "# Authorized source packet",
    "",
    ...sources.flatMap((source) => [
      `## ${source.id} — ${source.title}`,
      "",
      `Authority: ${source.authority}`,
      "",
      source.image
        ? `[Native image attached: ${source.image.mediaType}; sha256=${source.image.sha256}]`
        : withLineNumbers(source.content),
      ""
    ])
  ].join("\n");
}

async function readSourceImages(
  store: FactoryFileStore,
  state: FactoryRunState
): Promise<Array<{ mediaType: "image/jpeg" | "image/png" | "image/webp"; base64: string }>> {
  const refs = state.artifacts.sourceImages ?? [];
  return Promise.all(refs.map(async (ref) => ({
    mediaType: ref.mediaType,
    base64: (await store.readArtifact(ref.artifact)).trim()
  })));
}

function renderQuestionBatch(title: string, questions: CreatorQuestion[]): string {
  return [
    `# ${title}`,
    "",
    ...questions.flatMap((question) => [
      `## ${question.id}`,
      "",
      "### Question",
      "",
      question.question,
      "",
      "### Why this question",
      "",
      question.intent || "Not supplied",
      "",
      "### Leakage group",
      "",
      question.leakageGroup || question.id,
      ""
    ])
  ].join("\n");
}

function withLineNumbers(content: string): string {
  // Split only on LF so a preceding CR remains part of the source line. The
  // numbered packet can then be reversed byte-for-byte for valid UTF-8 CRLF,
  // LF, bare-CR, trailing-newline, BOM, and empty-file inputs.
  return content.split("\n").map((line, index) => `L${index + 1}: ${line}`).join("\n");
}

function renderEvaluationReport(title: string, rows: QaEvaluation[]): string {
  return [
    `# ${title}`,
    "",
    ...rows.flatMap((row) => [
      `## ${row.qa.id} — ${row.verdict.pass ? "PASS" : "FAIL"}`,
      "",
      "### Question",
      "",
      row.qa.question,
      "",
      "### Creator Answer",
      "",
      row.qa.answer,
      "",
      "### Hatch Result",
      "",
      row.hatchResult,
      "",
      "### Diagnosis",
      "",
      row.verdict.diagnosis,
      "",
      "### Few-shot candidate",
      "",
      row.verdict.fewShot,
      "",
      "### Corpus reflection",
      "",
      row.verdict.corpusReflection,
      ""
    ])
  ].join("\n");
}

function stablePartition(rows: CreatorQa[], seed: string, developmentCount: number): {
  development: CreatorQa[];
  heldout: CreatorQa[];
} {
  const groups = new Map<string, CreatorQa[]>();
  for (const row of rows) {
    const key = row.leakageGroup?.trim() || row.id;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  if (groups.size < 2) throw new Error("Creator questions need at least two leakage groups for Development/Held-out isolation");
  const orderedGroups = [...groups.entries()]
    .sort(([left], [right]) => stableKey(seed, left).localeCompare(stableKey(seed, right)));
  const developmentKeys = closestGroupSubset(orderedGroups, developmentCount);
  const development = orderedGroups.filter(([key]) => developmentKeys.has(key)).flatMap(([, values]) => values);
  const heldout = orderedGroups.filter(([key]) => !developmentKeys.has(key)).flatMap(([, values]) => values);
  if (development.length === 0 || heldout.length === 0) throw new Error("Leakage-group partition produced an empty split");
  return { development, heldout };
}

function closestGroupSubset(groups: Array<[string, CreatorQa[]]>, target: number): Set<string> {
  let candidates = new Map<number, string[]>([[0, []]]);
  for (const [key, rows] of groups) {
    const next = new Map(candidates);
    for (const [count, keys] of candidates) {
      const nextCount = count + rows.length;
      const nextKeys = [...keys, key];
      if (!next.has(nextCount)) next.set(nextCount, nextKeys);
    }
    candidates = next;
  }
  const usable = [...candidates].map(([count, keys]) => ({ count, keys }))
    .filter((candidate) => candidate.keys.length > 0 && candidate.keys.length < groups.length);
  usable.sort((left, right) => {
    const distance = Math.abs(left.count - target) - Math.abs(right.count - target);
    if (distance !== 0) return distance;
    return right.count - left.count;
  });
  return new Set(usable[0]?.keys ?? []);
}

function stableKey(seed: string, value: string): string {
  return createHash("sha256").update(`${seed}:${value}`).digest("hex");
}

function normalizedQuestion(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function creatorQaFromStructuredAnswers(answers: CreatorAnswerInput[], questions: CreatorQuestion[]): CreatorQa[] {
  const byId = new Map<string, string>();
  for (const item of answers) {
    const id = item.questionId?.trim();
    const answer = item.answer?.trim();
    if (!id || !answer) throw new Error("Every structured Creator answer needs questionId and answer");
    if (byId.has(id)) throw new Error(`Duplicate Creator answer: ${id}`);
    byId.set(id, answer);
  }
  const expected = new Set(questions.map((question) => question.id));
  const unexpected = [...byId.keys()].filter((id) => !expected.has(id));
  if (unexpected.length > 0) throw new Error(`Unexpected Creator answers: ${unexpected.join(", ")}`);
  return questions.flatMap((question) => {
    const answer = byId.get(question.id);
    return answer ? [{ ...question, answer }] : [];
  });
}

function safeLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function shortId(): string {
  return randomUUID().slice(0, 8);
}

function normalizeFactoryIdentity(input: FactoryStartInput): {
  agentId: string;
  product: FactoryRunState["product"];
} {
  requireUuidV4(input.creator?.id, "creator.id");
  const suppliedAgentId = input.agentId?.trim();
  const suppliedProductId = input.product?.id?.trim();
  const agentId = requireUuidV4(suppliedAgentId || suppliedProductId || randomUUID(), "product.id");
  const productId = requireUuidV4(suppliedProductId || agentId, "product.id");
  if (agentId !== productId) throw new Error("agentId and product.id must identify the same Product UUID");
  const productName = input.product?.name?.trim() || input.productName.trim();
  const description = input.product?.description?.trim() || input.productPromise.trim();
  const promise = input.product?.promise?.trim();
  const boundaries = input.product?.boundaries
    ?.map((boundary) => boundary.trim())
    .filter(Boolean);
  return {
    agentId,
    product: {
      id: productId,
      name: productName,
      ...(description ? { description } : {}),
      ...(promise ? { promise } : {}),
      ...(boundaries && boundaries.length > 0 ? { boundaries: [...new Set(boundaries)] } : {}),
      ...(input.product?.presentation ? { presentation: structuredClone(input.product.presentation) } : {})
    }
  };
}

function requireCorpusIdentifier(value: string, field: string): void {
  if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(value)) {
    throw new Error(`${field} must be a lowercase Agent Corpus identifier`);
  }
}

const DEFAULT_FACTORY_TOOLS: readonly FactoryAgentTool[] = [
  { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
  { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" }
];

function normalizeFactoryTools(input: FactoryAgentTool[] | undefined): FactoryAgentTool[] {
  const result = new Map<string, FactoryAgentTool>();
  const supplied = new Set<string>();
  for (const tool of DEFAULT_FACTORY_TOOLS) result.set(tool.id, { ...tool });
  for (const tool of input ?? []) {
    if (supplied.has(tool.id)) {
      throw new Error(`Duplicate Factory tool id: ${tool.id}`);
    }
    supplied.add(tool.id);
    result.set(tool.id, structuredClone(tool));
  }
  return [...result.values()];
}

function factoryTools(state: Pick<FactoryRunState, "tools">): FactoryAgentTool[] {
  return normalizeFactoryTools(state.tools);
}

function renderProductContract(product: FactoryRunState["product"]): string {
  return JSON.stringify(product, null, 2);
}

function chunkEvidenceSourcePacket(sourcePacket: string, maximumCharacters: number): string[] {
  if (sourcePacket.length <= maximumCharacters) return [sourcePacket];
  const chunks: string[] = [];
  let current = "";
  for (const line of sourcePacket.split(/(?<=\n)/)) {
    if (line.length > maximumCharacters) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let offset = 0; offset < line.length;) {
        let end = Math.min(offset + maximumCharacters, line.length);
        // Never split an astral Unicode character into isolated UTF-16
        // surrogates across two provider requests.
        if (
          end < line.length
          && end - offset > 1
          && isHighSurrogate(line.charCodeAt(end - 1))
          && isLowSurrogate(line.charCodeAt(end))
        ) {
          end -= 1;
        }
        chunks.push(line.slice(offset, end));
        offset = end;
      }
      continue;
    }
    if (current.length + line.length > maximumCharacters && current) {
      chunks.push(current);
      current = "";
    }
    current += line;
  }
  if (current) chunks.push(current);
  if (chunks.length < 2 || chunks.some((chunk) => !chunk.length || chunk.length > maximumCharacters)) {
    throw new Error("Unable to partition the authorized source packet within the Factory context budget");
  }
  return chunks;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function candidateCorpusRoot(systemPath: string): string {
  const match = /^candidate\/(v\d+-[A-Za-z0-9._-]+)\/(?:agent-corpus\/)?instructions\/system\.md$/.exec(systemPath);
  if (!match) throw new Error(`Candidate System path is not inside a clean Agent Corpus staging tree: ${systemPath}`);
  return `${match[1]}/agent-corpus`;
}

function sameArtifact(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.path === right.path
    && left.sha256 === right.sha256
    && left.sealed === right.sealed;
}

function isLegacyGuardReportPath(reportPath: string, version: number): boolean {
  return new RegExp(`^artifacts/evaluations/corpus-release-guard-v${version}-[^/]+\\.md$`)
    .test(reportPath);
}

function hasCompletenessReportReference(state: FactoryRunState, version: number): boolean {
  return state.artifacts.evaluationRounds.some((reference) => (
    new RegExp(`(?:^|/)corpus-completeness-v${version}-[^/]+\\.md$`).test(reference.path)
  ));
}

function isLegacyInconclusiveGuardReport(report: string): boolean {
  return report.includes("# Deterministic Corpus release guard")
    && /## Verdict\s+FAIL(?:\s|$)/.test(report)
    && /^- \[raw_source_overlap\].*; analysis: inconclusive \((?:anchor pair budget exceeded|match span budget exceeded|position search budget exceeded)\); release rejected$/m.test(report);
}

function renderEvaluationAsset(kind: "synthetic_qa" | "held_out", rows: QaEvaluation[]): string {
  if (rows.length === 0) throw new Error(`Agent Corpus ${kind} evaluation cannot be empty`);
  return `${JSON.stringify({
    contract_version: "1",
    evaluation_type: kind,
    question_generation: "llm",
    reference_answer_authority: "creator",
    cases: rows.map((row) => ({
      id: row.qa.id,
      leakage_group: row.qa.leakageGroup ?? row.qa.id,
      question: row.qa.question,
      ...(row.qa.intent ? { intent: row.qa.intent } : {}),
      creator_reference_answer: row.qa.answer,
      hatch_result: row.hatchResult,
      verdict: row.verdict.pass ? "PASS" : "FAIL",
      diagnosis: row.verdict.diagnosis,
      few_shot_candidate: row.verdict.fewShot,
      corpus_reflection: row.verdict.corpusReflection
    }))
  }, null, 2)}\n`;
}

function parsePromotedHeldoutCases(raw: string): CreatorQa[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Held-out review context is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Held-out review context is invalid");
  const row = parsed as Record<string, unknown>;
  if (row.contract_version !== "1" || row.evaluation_type !== "held_out" || !Array.isArray(row.cases)) {
    throw new Error("Held-out review context does not match the evaluation contract");
  }
  return row.cases.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (item.verdict !== "FAIL") return [];
    if (typeof item.id !== "string" || typeof item.question !== "string" || typeof item.creator_reference_answer !== "string") {
      throw new Error("Held-out review context contains an invalid failure case");
    }
    return [{
      id: item.id,
      question: item.question,
      ...(typeof item.intent === "string" ? { intent: item.intent } : {}),
      ...(typeof item.leakage_group === "string" ? { leakageGroup: item.leakage_group } : {}),
      answer: item.creator_reference_answer
    }];
  });
}

function referenceEvaluationAsset(kind: "synthetic_qa", rows: CreatorQa[]): unknown {
  if (rows.length === 0) throw new Error(`Agent Corpus ${kind} reference evaluation cannot be empty`);
  return {
    contract_version: "1",
    evaluation_type: kind,
    lifecycle: "factory_candidate_reference",
    question_generation: "llm",
    reference_answer_authority: "creator",
    live_context_policy: "eval_only",
    cases: rows.map((row) => ({
      id: row.id,
      leakage_group: row.leakageGroup ?? row.id,
      question: row.question,
      ...(row.intent ? { intent: row.intent } : {}),
      creator_reference_answer: row.answer
    }))
  };
}

/**
 * Structural placeholder owned by the Factory host, never by an LLM and never
 * derived from the active sealed set. Agent Corpus requires the held_out asset
 * path before Hatch can execute a candidate, but its contents remain empty
 * until the release gate passes and the final bundle is rematerialized.
 */
function provisionalHeldoutEvaluationAsset(): unknown {
  return {
    contract_version: "1",
    evaluation_type: "held_out",
    lifecycle: "factory_host_placeholder",
    live_context_policy: "eval_only",
    cases: []
  };
}

function validateStartInput(input: FactoryStartInput): void {
  if (!input.creator.id.trim() || !input.creator.name.trim()) throw new Error("Creator id and name are required");
  if (!input.productName.trim() || !input.productPromise.trim()) throw new Error("One concrete Product name and brief are required");
  normalizeFactoryIdentity(input);
  if (input.sources.length === 0) throw new Error("At least one authorized source is required");
  const development = input.config?.developmentQuestions ?? 6;
  const heldout = input.config?.heldoutQuestions ?? 3;
  if (!Number.isInteger(development) || development < 1) throw new Error("developmentQuestions must be a positive integer");
  if (!Number.isInteger(heldout) || heldout < 1) throw new Error("heldoutQuestions must be a positive integer");
  const revisions = input.config?.maxCorpusRevisions ?? 6;
  if (!Number.isInteger(revisions) || revisions < 1) throw new Error("maxCorpusRevisions must be a positive integer");
  const ids = new Set<string>();
  for (const source of input.sources) {
    if (
      typeof source.id !== "string"
      || typeof source.title !== "string"
      || typeof source.content !== "string"
      || !source.id.trim()
      || source.title.length === 0
      || /[\r\n]/.test(source.title)
    ) {
      throw new Error("Every source needs id, title, and string content");
    }
    if (ids.has(source.id)) throw new Error(`Duplicate source id: ${source.id}`);
    ids.add(source.id);
    if (source.image) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(source.image.mediaType)) {
        throw new Error(`Unsupported native image media type for source ${source.id}`);
      }
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(source.image.base64) || source.image.base64.length === 0) {
        throw new Error(`Native image source ${source.id} has invalid base64 bytes`);
      }
      if (!/^sha256:[a-f0-9]{64}$/.test(source.image.sha256)) {
        throw new Error(`Native image source ${source.id} has invalid sha256`);
      }
    }
  }
  if (input.sourceManifest) validateFactorySourceManifest(input.sourceManifest, input.sources);
  if (input.reviewContext) {
    if (!input.reviewContext.sourceRunId.trim() || input.reviewContext.sourceRunId === input.runId) {
      throw new Error("reviewContext.sourceRunId must reference a previous run");
    }
    if (!["correction", "heldout_correction", "question_replacement"].includes(input.reviewContext.mode)) {
      throw new Error("reviewContext.mode is invalid");
    }
    if (!input.reviewContext.artifact.path || !/^sha256:[a-f0-9]{64}$/.test(input.reviewContext.artifact.sha256)) {
      throw new Error("reviewContext.artifact must be an immutable artifact reference");
    }
    if (input.reviewContext.calibrationArtifact
      && (!input.reviewContext.calibrationArtifact.path || !/^sha256:[a-f0-9]{64}$/.test(input.reviewContext.calibrationArtifact.sha256))) {
      throw new Error("reviewContext.calibrationArtifact must be an immutable artifact reference");
    }
  }
}
