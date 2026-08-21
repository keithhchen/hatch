import { createHash, randomUUID } from "node:crypto";
import {
  aboutYouAnswersSchema,
  aboutYouInputSchema,
  aboutYouOutputSchema,
  aboutYouNode,
  type AboutYouAnswerPair,
  type AboutYouInput,
  type AboutYouOutput
} from "./aboutYouNode.js";
import { corpusInputSchema, corpusOutputSchema, corpusNode, type CorpusInput, type CorpusOutput } from "./corpusNode.js";
import { ProductFileStore } from "./productFiles.js";
import type { NodeScope } from "../node.js";
import { normalizeNodeObjectPath } from "../node.js";
import { NodeRuntime } from "../nodeRuntime.js";
import {
  NodeOssStore,
  type NodeStorage
} from "../nodeStorage.js";
import type {
  NodeExecutionState,
  NodeExecutionStore
} from "../nodeSession.js";

export type FactoryNodeProduct = {
  productId: string;
  name: string;
  promise: string;
  briefSpec?: unknown;
};

export type FactoryNodeRunView = {
  node: "about-you" | "corpus";
  productId: string;
  executionId: string;
  input: AboutYouInput | CorpusInput;
  output: AboutYouOutput | CorpusOutput;
  outputRef: string;
  candidateRef?: string;
  feedbackRef?: string;
  actorSessionIds: readonly string[];
  criticSessionIds: readonly string[];
};

export type FactoryNodeExecutionView = NodeExecutionState & {
  node: "about-you" | "corpus";
  productId: string;
  executionId: string;
  output?: AboutYouOutput | CorpusOutput;
};

export class FactoryNodeServiceError extends Error {
  constructor(
    readonly code:
      | "node_unavailable"
      | "execution_not_found"
      | "execution_not_ready"
      | "invalid_answers"
      | "invalid_about_you_ref"
      | "file_not_found",
    message: string,
    readonly status = code === "execution_not_found" || code === "file_not_found" ? 404 : 422
  ) {
    super(message);
    this.name = "FactoryNodeServiceError";
  }
}

/**
 * Host-side hand-off for the first two Factory Nodes.
 *
 * The LLM only sees the flat input manifest. This service creates the
 * immutable Product artifact, resolves Product File paths, stores Creator
 * answers, and starts the generic NodeRuntime. It deliberately knows nothing
 * about Corpus publishing, Eval, or Review.
 */
export class FactoryNodeService {
  private readonly nodeStore: NodeOssStore;
  private readonly productObjectPrefix: string;
  private readonly activeExecutions = new Map<string, Promise<void>>();

  constructor(
    private readonly runtime: NodeRuntime,
    private readonly executionStore: NodeExecutionStore,
    private readonly storage: NodeStorage,
    private readonly productFiles: ProductFileStore,
    productObjectPrefix = "creator-products"
  ) {
    this.nodeStore = new NodeOssStore(storage);
    this.productObjectPrefix = normalizeNodeObjectPath(productObjectPrefix);
  }

  async runAboutYou(input: {
    creatorId: string;
    product: FactoryNodeProduct;
    fileIds?: string[];
    filePaths?: string[];
    executionId?: string;
    signal?: AbortSignal;
  }): Promise<FactoryNodeRunView> {
    const executionId = executionIdFor("about-you", input.executionId);
    const nodeInput: AboutYouInput = {
      files: await this.resolveFilePaths(input.creatorId, input.product.productId, input.fileIds, input.filePaths),
      product: await this.writeProductArtifact(input.creatorId, input.product)
    };
    const result = await this.runtime.run(
      aboutYouNode,
      scope(input.product.productId, "about-you", executionId),
      nodeInput,
      input.signal
    );
    const state = await this.executionStore.load({ scope: scope(input.product.productId, "about-you", executionId) });
    return {
      node: "about-you",
      productId: input.product.productId,
      executionId,
      input: nodeInput,
      output: result.output,
      outputRef: result.outputRef,
      ...(state?.candidateRef ? { candidateRef: state.candidateRef } : {}),
      ...(state?.feedbackRef ? { feedbackRef: state.feedbackRef } : {}),
      actorSessionIds: result.actorSessionIds,
      criticSessionIds: result.criticSessionIds
    };
  }

  /** Start an execution without holding the HTTP request open for the LLM. */
  async startAboutYou(input: {
    creatorId: string;
    product: FactoryNodeProduct;
    fileIds?: string[];
    filePaths?: string[];
    executionId?: string;
  }): Promise<FactoryNodeExecutionView> {
    const executionId = executionIdFor("about-you", input.executionId);
    const nodeInput: AboutYouInput = {
      files: await this.resolveFilePaths(input.creatorId, input.product.productId, input.fileIds, input.filePaths),
      product: await this.writeProductArtifact(input.creatorId, input.product)
    };
    return this.enqueue("about-you", input.product.productId, executionId, nodeInput);
  }

  /**
   * Convert the UI's selected options into the only About You artifact that
   * Corpus consumes: an immutable array of { question, answer } pairs.
   */
  async saveAboutYouAnswers(input: {
    productId: string;
    executionId: string;
    answers: AboutYouAnswerPair[];
  }): Promise<{ productId: string; executionId: string; answersRef: string }> {
    const nodeScope = scope(input.productId, "about-you", input.executionId);
    const state = await this.executionStore.load({ scope: nodeScope });
    if (!state) throw new FactoryNodeServiceError("execution_not_found", `About You execution ${input.executionId} was not found`);
    if (!["completed", "waiting_for_creator"].includes(state.status) || !state.outputRef) {
      throw new FactoryNodeServiceError("execution_not_ready", `About You execution ${input.executionId} has not produced questions yet`, 409);
    }

    const output = aboutYouOutputSchema.parse(await this.nodeStore.readJson(nodeScope, state.outputRef));
    const pairs = aboutYouAnswersSchema.safeParse(input.answers);
    if (!pairs.success) {
      throw new FactoryNodeServiceError("invalid_answers", "Creator answers must be non-empty question/answer pairs");
    }
    validateAnswerPairs(output, pairs.data);
    const digest = sha256Json(pairs.data);
    const artifact = await this.nodeStore.writeImmutable(
      nodeScope,
      `creator-answers-${digest.slice(0, 40)}.json`,
      pairs.data
    );
    await this.executionStore.save({ scope: nodeScope }, {
      ...state,
      status: "handoff_saved",
      handoffRef: artifact.key,
      lastError: undefined
    });
    return { productId: input.productId, executionId: input.executionId, answersRef: artifact.key };
  }

  async startCorpus(input: {
    creatorId: string;
    product: FactoryNodeProduct;
    aboutYouRef: string;
    fileIds?: string[];
    filePaths?: string[];
    executionId?: string;
  }): Promise<FactoryNodeExecutionView> {
    const aboutYouRef = await this.validateAboutYouReference(input.product.productId, input.aboutYouRef);
    const executionId = executionIdFor("corpus", input.executionId);
    const nodeInput: CorpusInput = corpusInputSchema.parse({
      files: await this.resolveFilePaths(input.creatorId, input.product.productId, input.fileIds, input.filePaths),
      product: await this.writeProductArtifact(input.creatorId, input.product),
      about_you: aboutYouRef
    });
    return this.enqueue("corpus", input.product.productId, executionId, nodeInput);
  }

  async runCorpus(input: {
    creatorId: string;
    product: FactoryNodeProduct;
    aboutYouRef: string;
    fileIds?: string[];
    filePaths?: string[];
    executionId?: string;
    signal?: AbortSignal;
  }): Promise<FactoryNodeRunView> {
    const aboutYouRef = await this.validateAboutYouReference(input.product.productId, input.aboutYouRef);
    const executionId = executionIdFor("corpus", input.executionId);
    const nodeInput: CorpusInput = corpusInputSchema.parse({
      files: await this.resolveFilePaths(input.creatorId, input.product.productId, input.fileIds, input.filePaths),
      product: await this.writeProductArtifact(input.creatorId, input.product),
      about_you: aboutYouRef
    });
    const result = await this.runtime.run(
      corpusNode,
      scope(input.product.productId, "corpus", executionId),
      nodeInput,
      input.signal
    );
    const state = await this.executionStore.load({ scope: scope(input.product.productId, "corpus", executionId) });
    return {
      node: "corpus",
      productId: input.product.productId,
      executionId,
      input: nodeInput,
      output: result.output,
      outputRef: result.outputRef,
      ...(state?.candidateRef ? { candidateRef: state.candidateRef } : {}),
      ...(state?.feedbackRef ? { feedbackRef: state.feedbackRef } : {}),
      actorSessionIds: result.actorSessionIds,
      criticSessionIds: result.criticSessionIds
    };
  }

  async getExecution(
    productId: string,
    node: "about-you" | "corpus",
    executionId: string
  ): Promise<FactoryNodeExecutionView | undefined> {
    const executionScope = scope(productId, node, executionId);
    const state = await this.executionStore.load({ scope: executionScope });
    if (!state) return undefined;
    if ((state.status === "queued" || state.status === "running") && state.inputRef) {
      this.resumeIfNeeded(node, executionScope, state.inputRef);
    }
    const output = state.outputRef
      ? await this.nodeStore.readJson(executionScope, state.outputRef).catch(() => undefined)
      : undefined;
    return {
      node,
      productId,
      executionId,
      ...state,
      ...(output === undefined ? {} : { output: node === "about-you" ? aboutYouOutputSchema.parse(output) : corpusOutputSchema.parse(output) })
    };
  }

  async getLatestExecution(
    productId: string,
    node: "about-you" | "corpus"
  ): Promise<FactoryNodeExecutionView | undefined> {
    const latest = await this.executionStore.latest?.(productId, node);
    if (!latest) return undefined;
    return this.getExecution(productId, node, latest.scope.executionId);
  }

  /** The only hand-off lookup that may feed Publish: completed output only. */
  async getLatestCompletedExecution(
    productId: string,
    node: "about-you" | "corpus"
  ): Promise<FactoryNodeExecutionView | undefined> {
    const latest = await this.executionStore.latestCompleted?.(productId, node);
    if (latest?.state.status === "completed" && latest.state.outputRef) {
      return this.getExecution(productId, node, latest.scope.executionId);
    }
    const fallback = await this.executionStore.latest?.(productId, node);
    if (!fallback || fallback.state.status !== "completed" || !fallback.state.outputRef) return undefined;
    return this.getExecution(productId, node, fallback.scope.executionId);
  }

  private async enqueue(
    node: "about-you" | "corpus",
    productId: string,
    executionId: string,
    input: AboutYouInput | CorpusInput
  ): Promise<FactoryNodeExecutionView> {
    const executionScope = scope(productId, node, executionId);
    const existing = await this.executionStore.load({ scope: executionScope });
    if (existing?.inputRef) {
      const persisted = await this.nodeStore.readJson(executionScope, existing.inputRef);
      if (JSON.stringify(persisted) !== JSON.stringify(input)) {
        throw new FactoryNodeServiceError("execution_not_ready", `Execution ${executionId} already has a different input`, 409);
      }
    }
    const inputObject = await this.nodeStore.writeInput(executionScope, input);
    const state: NodeExecutionState = existing && ["completed", "waiting_for_creator", "handoff_saved"].includes(existing.status)
      ? { ...existing, inputRef: inputObject.key }
      : {
          status: "queued",
          round: existing?.round ?? 0,
          inputRef: inputObject.key,
          ...(existing?.candidateRef ? { candidateRef: existing.candidateRef } : {}),
          ...(existing?.feedbackRef ? { feedbackRef: existing.feedbackRef } : {}),
          ...(existing?.lastError ? { lastError: existing.lastError } : {})
        };
    await this.executionStore.save({ scope: executionScope }, state);
    if (!this.activeExecutions.has(executionKey(executionScope))) {
      const task = this.execute(node, executionScope, input)
        .catch(() => undefined)
        .finally(() => this.activeExecutions.delete(executionKey(executionScope)));
      this.activeExecutions.set(executionKey(executionScope), task);
    }
    const view = await this.getExecution(productId, node, executionId);
    if (!view) throw new FactoryNodeServiceError("execution_not_found", `Node execution ${executionId} was not created`);
    return view;
  }

  private resumeIfNeeded(node: "about-you" | "corpus", executionScope: NodeScope, inputRef: string): void {
    const key = executionKey(executionScope);
    if (this.activeExecutions.has(key)) return;
    const task = this.nodeStore.readJson(executionScope, inputRef)
      .then((input) => this.execute(node, executionScope, input as AboutYouInput | CorpusInput))
      .catch(() => undefined)
      .finally(() => this.activeExecutions.delete(key));
    this.activeExecutions.set(key, task);
  }

  private async execute(
    node: "about-you" | "corpus",
    executionScope: NodeScope,
    input: AboutYouInput | CorpusInput
  ): Promise<void> {
    if (node === "about-you") {
      await this.runtime.run(aboutYouNode, executionScope, aboutYouInputSchema.parse(input));
      const state = await this.executionStore.load({ scope: executionScope });
      if (state?.status === "completed") {
        await this.executionStore.save({ scope: executionScope }, { ...state, status: "waiting_for_creator" });
      }
      return;
    }
    await this.runtime.run(corpusNode, executionScope, corpusInputSchema.parse(input));
  }

  private async resolveFilePaths(
    creatorId: string,
    productId: string,
    fileIds?: string[],
    filePaths?: string[]
  ): Promise<string[]> {
    if (filePaths !== undefined) {
      const requested = uniquePaths(filePaths);
      const available = new Set(await this.productFiles.listProjectionPaths(creatorId, productId));
      if (!requested.length || requested.some((value) => !available.has(value))) {
        throw new FactoryNodeServiceError("file_not_found", "Every Node input file must be a File from this Product");
      }
      return requested;
    }
    const resolved = await this.productFiles.listProjectionPaths(creatorId, productId, fileIds);
    if (!resolved.length) throw new FactoryNodeServiceError("file_not_found", "A Node needs at least one Product File");
    return resolved;
  }

  private async writeProductArtifact(creatorId: string, product: FactoryNodeProduct): Promise<string> {
    const value = {
      product_id: product.productId,
      name: product.name,
      promise: product.promise,
      ...(product.briefSpec === undefined ? {} : { brief_spec: product.briefSpec })
    };
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    const digest = sha256(bytes);
    const key = `${this.productObjectPrefix}/${safePart(creatorId)}/${safePart(product.productId)}/product/product-${digest.slice(0, 40)}.json`;
    await this.storage.objectStore.put(key, bytes, {
      contentType: "application/json; charset=utf-8",
      immutable: true
    });
    return key;
  }

  private async validateAboutYouReference(productId: string, value: string): Promise<string> {
    let reference: string;
    try {
      reference = normalizeNodeObjectPath(value);
    } catch {
      throw new FactoryNodeServiceError("invalid_about_you_ref", "about_you must be a complete OSS object path");
    }
    const prefix = `${safePart(productId)}/about-you/`;
    if (!reference.startsWith(prefix) || !reference.includes("/creator-answers-") || !reference.endsWith(".json")) {
      throw new FactoryNodeServiceError("invalid_about_you_ref", "about_you must reference an About You Creator-answer artifact");
    }
    try {
      aboutYouAnswersSchema.parse(JSON.parse((await this.storage.objectStore.get(reference)).toString("utf8")));
    } catch {
      throw new FactoryNodeServiceError("invalid_about_you_ref", "about_you does not point to a valid Creator-answer artifact");
    }
    return reference;
  }
}

function scope(productId: string, nodeName: "about-you" | "corpus", executionId: string): NodeScope {
  return { productId: safePart(productId), nodeName, executionId: safePart(executionId) };
}

function executionKey(scopeValue: NodeScope): string {
  return `${scopeValue.productId}/${scopeValue.nodeName}/${scopeValue.executionId}`;
}

function executionIdFor(node: "about-you" | "corpus", requested?: string): string {
  const value = requested?.trim() || `${node.replaceAll("-", "_")}_${randomUUID().replaceAll("-", "")}`;
  return safePart(value);
}

function safePart(value: string): string {
  const normalized = value.trim();
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) throw new Error(`Unsafe Node scope part: ${value}`);
  return normalized;
}

function uniquePaths(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeNodeObjectPath(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function validateAnswerPairs(output: AboutYouOutput, pairs: AboutYouAnswerPair[]): void {
  if (pairs.length !== output.questions.length) {
    throw new FactoryNodeServiceError("invalid_answers", "Creator must answer every About You question exactly once");
  }
  const questions = new Map(output.questions.map((question) => [question.question, question]));
  const seen = new Set<string>();
  for (const pair of pairs) {
    const question = questions.get(pair.question);
    if (!question || seen.has(pair.question)) {
      throw new FactoryNodeServiceError("invalid_answers", `Unknown or duplicated About You question: ${pair.question}`);
    }
    // The UI offers an explicit Other field. Option text is preferred, but a
    // non-empty free answer is a valid Creator decision as well.
    seen.add(pair.question);
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}
