import { createHash, randomUUID } from "node:crypto";
import type http from "node:http";
import type { AgentCorpusResolverLike as AgentCorpusResolver } from "../agentCorpus.js";
import { RuntimeAssetStore } from "../assetStore.js";
import { MAX_BYTES as MAX_ASSET_BYTES } from "../assets/pipeline.js";
import { createBriefSnapshot } from "../brief.js";
import { ChatConversationReadModel } from "../chat/conversationReadModel.js";
import { publicJournalPayload } from "../chat/messageLedger.js";
import { sessionTokenFromCookie } from "../chat/originPolicy.js";
import { publicRun } from "../chat/publicRun.js";
import { finalAssistantText, TERMINAL_STATUSES, waitForTerminalRun } from "../chat/runResult.js";
import {
  conversationBinding,
  durableConversationId,
  privateBoundaryProjection,
  sanitizeBoundHistory,
  type LegacyHmacAuth
} from "../chat/sessionBinding.js";
import { projecting, SseSink, type EventProjection } from "../chat/sinks.js";
import type { Submission } from "../chat/chatService.js";
import { retryRun, submitUserMessage, type ChatEdge } from "../chat/turnSubmission.js";
import { ConversationError as ConversationHttpError } from "../conversations/conversation.js";
import type {
  ConversationJournalEvent,
  ConversationRecord,
  ConversationRepository
} from "../conversationRepository.js";
import type { AuthIdentityResolver, EntitlementResolver } from "../entitlements.js";
import { clientAttributesOf, MAX_USER_MESSAGE_CHARS, ToolCallResultSchema } from "../protocol.js";
import type { RuntimeStore } from "../store.js";
import type { ContentPart } from "../surfaces/contract.js";
import {
  bearerToken,
  MAX_WAIT_SECONDS,
  optionalString,
  parseConversationStatus,
  parseNonNegativeInteger,
  parsePositiveInteger,
  positiveIntegerValue,
  readBoundedBytes,
  readJsonObject,
  rejectUnknownFields,
  requiredString,
  valueString,
  writeJsonBounded
} from "./httpSupport.js";
import { requireBoundConversation, requireConversationBinding } from "./requestBinding.js";

/** What the /v1/conversations routes need from the rest of the Runtime; the router supplies it. */
export type ConversationRouteDeps = {
  repository: ConversationRepository;
  store: RuntimeStore | undefined;
  assetStore: RuntimeAssetStore | undefined;
  entitlementResolver: EntitlementResolver | undefined;
  agentCorpusResolver: AgentCorpusResolver | undefined;
  authIdentityResolver: AuthIdentityResolver | undefined;
  legacyHmacAuth: LegacyHmacAuth;
  edge: ChatEdge | undefined;
  maxHttpResponseBytes: number;
  allowedOrigins: readonly string[];
};

/** The largest file the asset pipeline takes: a larger upload is refused before it is read. */
const MAX_UPLOAD_BYTES = Math.max(...Object.values(MAX_ASSET_BYTES));

/**
 * HTTP is the durable Library/read model. The WebSocket remains the executor
 * transport for a run, but both paths use the same repository and binding.
 * This makes renderer reload/reconnect recovery possible without treating the
 * transcript event log as a control-plane database.
 */
export async function handleConversationHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: ConversationRouteDeps,
  signal: AbortSignal | undefined
): Promise<void> {
  const {
    repository, store, assetStore, entitlementResolver, agentCorpusResolver, authIdentityResolver,
    legacyHmacAuth, edge, maxHttpResponseBytes, allowedOrigins
  } = deps;
  const binding = await requireConversationBinding(
    req,
    url,
    entitlementResolver,
    agentCorpusResolver,
    authIdentityResolver,
    legacyHmacAuth,
    signal
  );
  const repoBinding = conversationBinding(binding);
  const writeResponse = (status: number, body: unknown) => writeJsonBounded(res, status, body, maxHttpResponseBytes);
  const authToken = bearerToken(req);
  // A cookie is sent by the browser on any cross-site request, so changing anything with one needs an allowed Origin.
  if (req.method !== "GET" && typeof req.headers.authorization !== "string" && sessionTokenFromCookie(req.headers.cookie)
    && !(typeof req.headers.origin === "string" && allowedOrigins.includes(req.headers.origin))) {
    throw new ConversationHttpError(403, "origin_not_allowed", "This origin may not use a browser session.");
  }
  const requireEdge = (): ChatEdge => {
    if (!edge) throw new ConversationHttpError(503, "chat_unavailable", "The Chat API is unavailable.");
    return edge;
  };

  if (url.pathname === "/v1/conversations") {
    if (req.method === "GET") {
      const status = parseConversationStatus(url.searchParams.get("status"));
      const limit = parsePositiveInteger(url.searchParams.get("limit"), "limit", 100);
      const page = await repository.listConversations(repoBinding, {
        ...(status ? { status } : {}),
        ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        ...(limit ? { limit } : {})
      });
      writeResponse(200, {
        conversations: page.conversations.map(publicConversation),
        ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
        sent_message_count: await repository.countSentMessages(repoBinding)
      });
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonObject(req);
      rejectUnknownFields(body, ["title", "client_request_id", "brief_answers"]);
      const title = optionalString(body, "title", 500);
      const clientRequestId = optionalString(body, "client_request_id", 256);
      const briefSnapshot = binding.briefSpec
        ? createBriefSnapshot(binding.briefSpec, body.brief_answers)
        : undefined;
      const publicId = `conv_${randomUUID().replaceAll("-", "")}`;
      const created = await repository.createConversation({
        ...repoBinding,
        id: durableConversationId(binding, publicId),
        publicId,
        ...(title ? { title } : {}),
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(briefSnapshot ? { briefSnapshot } : {})
      });
      writeResponse(created.created ? 201 : 200, { conversation: publicConversation(created.conversation), created: created.created });
      return;
    }
    throw new ConversationHttpError(405, "method_not_allowed", "Use GET or POST for /v1/conversations.");
  }

  const uploadMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/assets$/);
  if (uploadMatch) {
    if (req.method !== "POST") throw new ConversationHttpError(405, "method_not_allowed", "Use POST to upload a file.");
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(uploadMatch[1] ?? ""));
    const chatAssets = requireEdge().chatAssets;
    if (!chatAssets) throw new ConversationHttpError(501, "attachments_unavailable", "This Runtime cannot take attachments.");
    // The file is the request body and its name is `?name=`: it becomes a ready asset, or is refused with the reason.
    const name = url.searchParams.get("name")?.trim();
    if (!name) throw new ConversationHttpError(400, "invalid_upload", "name is the file's name.");
    const bytes = await readBoundedBytes(req, MAX_UPLOAD_BYTES);
    if (!bytes.length) throw new ConversationHttpError(400, "invalid_upload", "The file is empty.");
    writeResponse(201, await chatAssets.upload(conversation, { name, bytes }));
    return;
  }

  const assetMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/assets\/([^/]+)$/);
  if (assetMatch) {
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(assetMatch[1] ?? ""));
    if (req.method !== "GET") {
      throw new ConversationHttpError(405, "method_not_allowed", "Use GET for a conversation asset.");
    }
    await serveConversationAsset(
      res,
      store,
      assetStore,
      conversation.id,
      decodeURIComponent(assetMatch[2] ?? "")
    );
    return;
  }

  const conversationMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)$/);
  if (conversationMatch) {
    const resolved = await requireBoundConversation(repository, binding, decodeURIComponent(conversationMatch[1] ?? ""));
    if (req.method === "GET") {
      writeResponse(200, { conversation: publicConversation(resolved) });
      return;
    }
    if (req.method === "PATCH") {
      const body = await readJsonObject(req);
      rejectUnknownFields(body, ["title", "status", "version"]);
      const title = body.title === null ? null : optionalString(body, "title", 500);
      const status = body.status === undefined ? undefined : parseConversationStatus(valueString(body, "status"));
      const expectedVersion = body.version === undefined ? undefined : positiveIntegerValue(body.version, "version", Number.MAX_SAFE_INTEGER);
      if (body.title === undefined && body.status === undefined) {
        throw new ConversationHttpError(400, "metadata_required", "Provide title or status when updating a conversation.");
      }
      const updated = await repository.updateConversation(resolved.id, {
        ...(body.title !== undefined ? { title } : {}),
        ...(status ? { status } : {}),
        ...(expectedVersion ? { expectedVersion } : {})
      });
      writeResponse(200, { conversation: publicConversation(updated) });
      return;
    }
    throw new ConversationHttpError(405, "method_not_allowed", "Use GET or PATCH for a conversation.");
  }

  const toolDetailMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/tools\/([^/]+)\/([^/]+)$/);
  if (toolDetailMatch && req.method === "GET") {
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(toolDetailMatch[1] ?? ""));
    if (!store) throw new ConversationHttpError(503, "history_unavailable", "Conversation history is unavailable.");
    const tool = await store.readConversationToolDetail(conversation.id,
      decodeURIComponent(toolDetailMatch[2] ?? ""), decodeURIComponent(toolDetailMatch[3] ?? ""));
    if (!tool) throw new ConversationHttpError(404, "tool_not_found", "The tool output was not found in this conversation.");
    const projected = sanitizeBoundHistory([{
      run_id: tool.run_id, role: "assistant", content: "", timestamp: tool.timestamp, tool_calls: [tool]
    }], binding.productId);
    writeResponse(200, { tool: projected[0]?.tool_calls?.[0] });
    return;
  }

  const historyMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(historyMatch[1] ?? ""));
    if (!store) throw new ConversationHttpError(503, "history_unavailable", "Conversation history is unavailable.");
    const limit = parsePositiveInteger(url.searchParams.get("limit"), "limit", 100) ?? 50;
    const page = await new ChatConversationReadModel({ history: store, repository }).page(conversation.id, {
      limit,
      beforeCursor: url.searchParams.get("before_cursor") ?? undefined
    });
    writeResponse(200, { ...page, messages: sanitizeBoundHistory(page.messages, binding.productId) });
    return;
  }

  const snapshotMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/(snapshot|events)$/);
  if (snapshotMatch && req.method === "GET") {
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(snapshotMatch[1] ?? ""));
    const afterCursor = parseNonNegativeInteger(url.searchParams.get("after_cursor"), "after_cursor");
    if (url.searchParams.get("view") === "page") {
      if (snapshotMatch[2] === "events") {
        const throughCursor = parseNonNegativeInteger(url.searchParams.get("through_cursor"), "through_cursor");
        const limit = parsePositiveInteger(url.searchParams.get("limit"), "limit", 200) ?? 100;
        const page = await repository.journalPage(conversation.id, afterCursor ?? 0, throughCursor, limit);
        writeResponse(200, {
          ...page,
          conversation_id: conversation.publicId,
          events: page.events.map(publicJournalEvent),
          runs: page.runs.map(publicRun)
        });
        return;
      }
      if (!store) throw new ConversationHttpError(503, "history_unavailable", "Conversation history is unavailable.");
      // Capture the recovery waterline before reading the projection. Events
      // committed while history is loading are then covered by incremental recovery.
      const snapshot = await repository.recoverySnapshot(conversation.id, []);
      const page = await new ChatConversationReadModel({ history: store, repository }).page(conversation.id, { limit: 50 });
      const pageRuns = await Promise.all(page.run_ids.map((id) => repository.getRun(conversation.id, id)));
      const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
      for (const run of pageRuns) if (run) runs.set(run.id, run);
      writeResponse(200, {
        conversation: publicConversation(snapshot.conversation),
        ...page,
        messages: sanitizeBoundHistory(page.messages, binding.productId),
        runs: [...runs.values()].map(publicRun),
        events: [],
        cursor: snapshot.cursor
      });
      return;
    }
    if (snapshotMatch[2] === "events" && String(req.headers.accept ?? "").includes("text/event-stream")) {
      // Resume by cursor: after_cursor, or the Last-Event-ID the browser echoes on reconnect.
      const lastEventId = Number(req.headers["last-event-id"]);
      const resumeAfter = afterCursor ?? (Number.isSafeInteger(lastEventId) && lastEventId >= 0 ? lastEventId : (await repository.recoverySnapshot(conversation.id, [])).cursor);
      openEventStream(res, requireEdge(), conversation, resumeAfter, privateBoundaryProjection(() => binding));
      return;
    }
    const snapshot = await repository.snapshot(conversation.id, afterCursor ?? 0);
    const eventResponse = snapshot.events.map(publicJournalEvent);
    if (snapshotMatch[2] === "events") {
      writeResponse(200, { conversation_id: conversation.publicId, events: eventResponse, cursor: snapshot.cursor });
      return;
    }
    const messages = store
      ? sanitizeBoundHistory(await store.readVisibleConversation(conversation.id), binding.productId)
      : [];
    writeResponse(200, {
      conversation: publicConversation(snapshot.conversation),
      runs: snapshot.runs.map(publicRun),
      messages,
      events: eventResponse,
      cursor: snapshot.cursor,
      pending_tool_calls: await edge?.chat.pendingToolRequests(conversation.id) ?? []
    });
    return;
  }

  const messagesMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/messages$/);
  if (messagesMatch) {
    if (req.method !== "POST") throw new ConversationHttpError(405, "method_not_allowed", "Use POST to send a message.");
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(messagesMatch[1] ?? ""));
    const body = await readJsonObject(req);
    rejectUnknownFields(body, ["client_message_id", "content", "parts", "client", "device", "locale", "language", "time_zone"]);
    const clientMessageId = requiredString(body, "client_message_id", 256);
    if ((body.content === undefined) === (body.parts === undefined)) {
      throw new ConversationHttpError(400, "invalid_request", "Provide either content or parts.");
    }
    const content = body.content !== undefined ? requiredString(body, "content", MAX_USER_MESSAGE_CHARS) : "";
    const chatEdge = requireEdge();
    // Parts may refer to ready assets: they are resolved before anything is accepted.
    const prepared = body.parts !== undefined ? await chatEdge.parts.prepare(contentPartsOf(body.parts), conversation, clientMessageId) : undefined;
    const wait = parseNonNegativeInteger(url.searchParams.get("wait"), "wait") ?? 0;
    const streaming = String(req.headers.accept ?? "").includes("text/event-stream");
    // Without more to go on, an HTTP caller is an agent without a machine for local tools.
    const client = clientAttributesOf({ client: "mcp", ...body } as { client?: string });
    const before = (await repository.recoverySnapshot(conversation.id, [])).cursor;
    const { submission } = await submitUserMessage(chatEdge, { authToken, binding, conversation }, {
      runId: `run_${randomUUID().replaceAll("-", "")}`,
      clientMessageId,
      ...(prepared ? { prepared } : {}),
      message: { role: "user", content },
      taskStart: false,
      client,
      ...(typeof body.time_zone === "string" ? { timeZone: body.time_zone } : {})
    }, signal);
    if (streaming) {
      // A send replayed after its Run ended has no end left to wait for: it is answered with the Run's result.
      const ended = submission.outcome === "replayed" ? await repository.getRun(conversation.id, submission.run.id) : undefined;
      const finished = ended && TERMINAL_STATUSES.has(ended.status) ? {
        status: ended.status,
        reply: ended.status === "completed" && store ? finalAssistantText(await store.readVisibleConversation(conversation.id), ended.id) : "",
        cursor: await repository.latestRunStateCursor(ended.id)
      } : undefined;
      openEventStream(res, chatEdge, conversation, before, privateBoundaryProjection(() => binding), submission, finished);
      return;
    }
    const run = await waitForTerminalRun(() => repository.getRun(conversation.id, submission.run.id), Math.min(wait, MAX_WAIT_SECONDS) * 1000, 100, signal);
    if (!run || !TERMINAL_STATUSES.has(run.status)) {
      writeResponse(202, { run_id: submission.run.id, outcome: submission.outcome, status: run?.status ?? submission.run.status });
      return;
    }
    const reply = run.status === "completed" && store ? finalAssistantText(await store.readVisibleConversation(conversation.id), run.id) : "";
    writeResponse(200, { run: publicRun(run), outcome: submission.outcome, reply });
    return;
  }

  const retryMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/retry$/);
  if (retryMatch) {
    if (req.method !== "POST") throw new ConversationHttpError(405, "method_not_allowed", "Use POST to answer again.");
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(retryMatch[1] ?? ""));
    const body = await readJsonObject(req);
    rejectUnknownFields(body, ["retry_id", "client", "device", "locale", "language", "time_zone"]);
    // The client's key for this answer again: the same key is the same Run, whatever happened to the response.
    const retried = await retryRun(requireEdge(), { authToken, binding, conversation }, {
      runId: `run_${randomUUID().replaceAll("-", "")}`,
      key: requiredString(body, "retry_id", 256),
      client: clientAttributesOf({ client: "mcp", ...body } as { client?: string }),
      ...(typeof body.time_zone === "string" ? { timeZone: body.time_zone } : {})
    }, signal);
    writeResponse(202, { run_id: retried.run.id, outcome: retried.outcome, status: retried.run.status });
    return;
  }

  const toolResultsMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/tool-results$/);
  if (toolResultsMatch) {
    if (req.method !== "POST") throw new ConversationHttpError(405, "method_not_allowed", "Use POST to provide a tool result.");
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(toolResultsMatch[1] ?? ""));
    const chatEdge = requireEdge();
    const { client: clientField, ...resultBody } = await readJsonObject(req);
    const result = ToolCallResultSchema.parse({ type: "tool_call.result", ...resultBody });
    const client = clientAttributesOf({ client: typeof clientField === "string" ? clientField : "cli" });
    const answer = await chatEdge.chat.answerTool(conversation.id, result, client.client);
    if (answer.outcome !== "accepted") throw new ConversationHttpError(answer.outcome === "forbidden" ? 403 : 404, answer.error.code, answer.error.message);
    writeResponse(200, { accepted: true });
    return;
  }

  const runsMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/runs$/);
  if (runsMatch) {
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(runsMatch[1] ?? ""));
    if (req.method === "GET") {
      writeResponse(200, { conversation_id: conversation.publicId, runs: (await repository.listRuns(conversation.id)).map(publicRun) });
      return;
    }
    throw new ConversationHttpError(405, "method_not_allowed", "Use GET for runs; send a message with POST /messages to start or steer a Run.");
  }

  const runMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/runs\/([^/]+)(?:\/(cancel))?$/);
  if (runMatch) {
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(runMatch[1] ?? ""));
    const runId = decodeURIComponent(runMatch[2] ?? "");
    if (runMatch[3] === "cancel" && req.method === "POST") {
      const body = await readJsonObject(req);
      rejectUnknownFields(body, ["reason"]);
      const reason = optionalString(body, "reason", 500) ?? "Run cancelled";
      await requireEdge().chat.cancel(conversation.id, runId, reason);
      const run = await repository.getRun(conversation.id, runId);
      if (!run) throw new ConversationHttpError(404, "run_not_found", `Run ${runId} was not found.`);
      if (!store) throw new ConversationHttpError(503, "history_unavailable", "Message acceptance is unavailable.");
      const receipt = await store.readSubmissionReceipt(conversation.id, runId);
      writeResponse(200, { run: publicRun(run), submission: receipt ?? null });
      return;
    }
    if (!runMatch[3] && req.method === "GET") {
      const run = await repository.getRun(conversation.id, runId);
      if (!run) throw new ConversationHttpError(404, "run_not_found", `Run ${runId} was not found.`);
      if (!store) throw new ConversationHttpError(503, "history_unavailable", "Message acceptance is unavailable.");
      const receipt = await store.readSubmissionReceipt(conversation.id, runId);
      writeResponse(200, { run: publicRun(run), submission: receipt ?? null });
      return;
    }
    throw new ConversationHttpError(405, "method_not_allowed", "Use GET for a run or POST for /cancel.");
  }

  throw new ConversationHttpError(404, "not_found", "Conversation route was not found.");
}

export async function serveConversationAsset(
  res: http.ServerResponse,
  store: RuntimeStore | undefined,
  assetStore: RuntimeAssetStore | undefined,
  conversationId: string,
  assetId: string
): Promise<void> {
  if (!store || !assetStore) {
    throw new ConversationHttpError(503, "asset_store_unavailable", "Conversation assets are temporarily unavailable.");
  }
  if (!assetId) {
    throw new ConversationHttpError(404, "asset_not_found", "The conversation asset was not found.");
  }

  // The transcript is the authorization boundary for binary assets. A caller
  // may only read an asset whose immutable reference was already committed to
  // this conversation; knowing or guessing an asset_id is not sufficient.
  const reference = await store.readConversationAssetReference(conversationId, assetId);
  if (!reference) {
    throw new ConversationHttpError(404, "asset_not_found", "The conversation asset was not found.");
  }

  let bytes: Buffer;
  try {
    bytes = await assetStore.read(assetId, reference.storage_ref);
  } catch (error) {
    if (isMissingAssetError(error)) {
      throw new ConversationHttpError(404, "asset_not_found", "The conversation asset is no longer available.");
    }
    throw new ConversationHttpError(500, "asset_unavailable", "The conversation asset could not be read.");
  }
  if (bytes.byteLength !== reference.source_bytes
    || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
    throw new ConversationHttpError(500, "asset_corrupt", "The conversation asset failed its integrity check.");
  }

  const mediaType = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(reference.media_type)
    ? reference.media_type
    : "application/octet-stream";
  const filename = encodeURIComponent(reference.display_name.replace(/[\r\n]/g, "_")).replaceAll("'", "%27");
  res.writeHead(200, {
    "content-type": mediaType,
    "content-length": String(bytes.byteLength),
    "content-disposition": `inline; filename*=UTF-8''${filename}`,
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff"
  });
  res.end(bytes);
}

function isMissingAssetError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (("code" in error && ["ENOENT", "NoSuchKey", "NotFound"].includes(String((error as { code?: unknown }).code)))
      || ("status" in error && Number((error as { status?: unknown }).status) === 404)
      || ("statusCode" in error && Number((error as { statusCode?: unknown }).statusCode) === 404))
  );
}

function publicConversation(conversation: ConversationRecord): Record<string, unknown> {
  return {
    id: conversation.publicId,
    creator_id: conversation.creatorId,
    agent_id: conversation.agentId,
    product_id_at_creation: conversation.productIdAtCreation,
    ...(conversation.title ? { title: conversation.title } : {}),
    status: conversation.status,
    created_at: conversation.createdAt,
    updated_at: conversation.updatedAt,
    version: conversation.version,
    ...(conversation.briefSnapshot ? { brief_snapshot: conversation.briefSnapshot } : {})
  };
}

function contentPartsOf(value: unknown): ContentPart[] {
  if (!Array.isArray(value) || value.length === 0) throw new ConversationHttpError(400, "invalid_request", "parts must be a non-empty array.");
  return value.map((part) => {
    const record = part as Record<string, unknown>;
    if (record?.type === "text" && typeof record.text === "string") return { type: "text" as const, text: record.text };
    if ((record?.type === "image" || record?.type === "file" || record?.type === "audio") && typeof record.assetId === "string") {
      return { type: record.type, assetId: record.assetId };
    }
    throw new ConversationHttpError(400, "invalid_request", "Each part is text, or an image, file or audio with an assetId.");
  });
}

/**
 * Streams a conversation as Server-Sent Events from a cursor. The stream ends when the
 * Run it was opened for ends; closing it early never stops the Run.
 */
function openEventStream(
  res: http.ServerResponse,
  edge: ChatEdge,
  conversation: ConversationRecord,
  afterCursor: number,
  project: EventProjection,
  submission?: Submission,
  /** The submission's Run had already ended: the stream carries its reply and its end, and closes. */
  finished?: { status: string; reply: string; cursor?: number }
): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const sink = projecting(new SseSink(res, edge.consumerBufferedBytes), project);
  if (submission) {
    sink.push({ type: "message.accepted", conversation_id: conversation.publicId, run_id: submission.run.id, client_message_id: submission.clientMessageId, outcome: submission.outcome });
  }
  if (submission && finished) {
    if (finished.reply) sink.push({ type: "assistant.delta", run_id: submission.run.id, delta: { kind: "text", content: finished.reply, offset: 0 } });
    sink.push({ type: "journal.event", ...(finished.cursor === undefined ? {} : { cursor: finished.cursor }), journal_type: "run.state", run_id: submission.run.id, payload: { id: submission.run.id, status: finished.status } });
    res.end();
    return;
  }
  const detach = edge.chat.feed.attach(conversation.id, { afterCursor, stream: true }, {
    push(event) {
      sink.push(event);
      const ended = event.type === "journal.event" && event.journal_type === "run.state" && event.run_id === submission?.run.id
        && TERMINAL_STATUSES.has(String((event.payload as { status?: string }).status));
      if (ended) { detach(); res.end(); }
    }
  });
  res.once("close", detach);
  void edge.chat.pendingToolRequests(conversation.id).then((pending) => {
    for (const request of pending) { try { sink.push(request as unknown as Record<string, unknown>); } catch { detach(); } }
  });
}

function publicJournalEvent(event: ConversationJournalEvent): Record<string, unknown> {
  return {
    cursor: event.cursor,
    ...(event.runId ? { run_id: event.runId } : {}),
    type: event.type,
    payload: publicJournalPayload(event.payload),
    created_at: event.createdAt
  };
}
