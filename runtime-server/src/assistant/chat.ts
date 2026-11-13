import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "../agentRuntime.js";
import { PiAgentRuntime } from "../piAgentRuntime.js";
import type { RuntimeAssetStore } from "../assetStore.js";
import type { CompactionStrategy } from "../compactionStrategy.js";
import { chatCompactionStrategy, type RuntimeCompactionMessage } from "../compaction.js";
import type { ConversationRecord, ConversationRepository, ConversationRunRecord } from "../conversationRepository.js";
import { failureOfReason } from "../errors/failures.js";
import { ChatAssets, attachmentMessageId } from "../chat/assets.js";
import type { ChatGateway, ConversationRef, SentMessage, UploadedRef } from "../chat/gateway.js";
import { ChatRuntime } from "../chat/chatRuntime.js";
import { attributeByScope, payerByScope, type UsageRecorder } from "../usage/usage.js";
import type { UsageCap } from "../usage/usageCap.js";
import { NO_SKILLS, failRun, runModelTurn, type TurnBinding } from "../chat/modelTurn.js";
import { ChatError, accountPrincipal } from "../chat/principal.js";
import type { Retried } from "../chat/chatService.js";
import { ServiceChatGateway, type PrincipalBinder } from "../chat/serviceGateway.js";
import type { ScopeResolver, TurnRunner } from "../chat/turnExecutor.js";
import { ConversationError, DEFAULT_PAGE, MAX_PAGE, type ConversationStatus, type HistoryPage, type PublicMessage, type SendInput, type Sent } from "../conversations/conversation.js";
import { ChatConversationReadModel, type ConversationReadModel } from "../chat/conversationReadModel.js";
import { PassThroughOutputGuard, type OutputGuard } from "../outputGuard.js";
import { ServerToolExecutor } from "../serverTools.js";
import type { RuntimeStore } from "../store.js";
import { HistoryCursorError } from "../conversationHistory.js";
import { ToolBridge } from "../toolBridge.js";
import type { ClientAttributes, ContentPart } from "../surfaces/contract.js";
import { isSystemMessageId, SYSTEM_MESSAGE_PREFIX } from "./systemMessage.js";
import type { AssistantStateRepository, LastExpert } from "./state.js";
import { JournalFeed } from "./journalFeed.js";
import { accountOfConversation, assistantConversationId, assistantFeedKey } from "./studioVocabulary.js";
import { StudioToolRunner, studioToolNames, type StudioTool } from "./studioTools.js";
import type { TaskOrigin } from "./tasks.js";
import type { LegacyAssistantHistory } from "./history.js";
import type { AssistantHost } from "../conversations/assistantConversation.js";
import type { AssetDesk } from "../conversations/assets.js";
import { log } from "../observability/log.js";
import { bindContext, currentContext } from "../observability/context.js";
import { memoizeSuccess } from "../memoizeSuccess.js";
import type { ModelRoleResolver } from "../modelRoles.js";

/** The Assistant is one Agent, not a Product: its conversation is bound to the account, under this id. A UUID, as every Agent id is once the identity migration has run. */
export const ASSISTANT_AGENT_ID = "a5515700-0000-4000-8000-000000000001";
const ACTIVE = new Set(["queued", "running", "waiting_for_tool", "compacting"]);

/**
 * The Assistant's history is the Expert's whole working life, so its context is held to a fixed budget instead of the model's
 * window: a summary after the reply that crosses `trigger`, the newest `tail` tokens kept verbatim, old tool results pruned from `prune`.
 * `hard` is the size at which a turn that is about to run waits for a summary rather than ride on.
 */
export const ASSISTANT_CONTEXT_BUDGET = { trigger: 40_000, tail: 15_000, prune: 25_000, hard: 100_000 } as const;

/** What a Run of the Assistant needs beyond the binding every Chat Run has. */
export type AssistantScope = TurnBinding & { accountId: string };

export type AssistantChatDeps = {
  repository: ConversationRepository;
  store: RuntimeStore;
  assetStore: RuntimeAssetStore;
  chatAssets: ChatAssets;
  state: AssistantStateRepository;
  tools: readonly StudioTool[];
  history: Pick<LegacyAssistantHistory, "importInto">;
  /** The Assistant's whole system prompt. */
  prompt: () => Promise<string>;
  /** What the Assistant sees of the Expert's Agents and tasks right now; rebuilt for every model call. */
  liveState: (accountId: string) => Promise<string>;
  env: NodeJS.ProcessEnv;
  /** Where the Assistant's model is chosen (role `assistant`): read at the start of each Run and each compaction. */
  models: ModelRoleResolver;
  /** Replaces the model, for tests. */
  createRuntime?: () => AgentRuntime;
  outputGuard?: OutputGuard;
  compactionStrategy?: () => CompactionStrategy<RuntimeCompactionMessage>;
  toolTimeoutMs?: number;
  leaseMs?: number;
  sweepMs?: number;
  report?: (accountId: string, error: unknown) => void;
  /** Where the Assistant's model calls are recorded, as Studio usage of the Expert. */
  usage?: UsageRecorder;
  /** Refuses a new Assistant Run when the Expert has spent their month. */
  usageCap?: UsageCap;
};

/** The Assistant's one conversation per account is the account's own: nothing else binds to it. */
class AssistantBinder implements PrincipalBinder<AssistantScope> {
  constructor(private readonly chat: AssistantChat) {}

  async bind(principal: Parameters<PrincipalBinder<AssistantScope>["bind"]>[0], _ref: ConversationRef) {
    if (principal.kind !== "account") throw new ChatError("principal_not_allowed", "Only the Expert reaches the Assistant.", 403);
    const conversation = await this.chat.conversation(principal.accountId);
    return { conversation, scope: this.chat.scopeOf(conversation), corpusDigest: conversation.corpusDigest, requiresLocalTools: false };
  }
}

/** Studio work: the API's when an API key made the request that is binding the Run, the web's otherwise. */
export const scopeOfConversation = (conversation: Pick<ConversationRecord, "ownerAccountId">): AssistantScope => {
  const apiKeyId = currentContext()?.api_key_id;
  return {
    creatorId: conversation.ownerAccountId, userId: conversation.ownerAccountId, productId: ASSISTANT_AGENT_ID, corpusDigest: ASSISTANT_AGENT_ID, accountId: conversation.ownerAccountId,
    usageSurface: apiKeyId ? "studio_api" : "studio_web", ...(apiKeyId ? { apiKeyId } : {})
  };
};

/**
 * The Assistant as a conversation on Chat's runtime: the same Runs, steering, resume, compaction, idempotency and
 * attachments as a Product's, with the Studio tools and the Assistant's own prompt. It is hosted here, in the process that
 * holds the Expert's Products and tasks, so its tools are calls rather than requests.
 */
export class AssistantChat implements AssistantHost {
  readonly runtime: ChatRuntime<AssistantScope>;
  readonly gateway: ChatGateway;
  private readonly conversations = new Map<string, Promise<ConversationRecord>>();
  private readonly readModel: ConversationReadModel;
  /** The Assistant's events for Studio observers: Chat's own journal in Studio's words, with the live steps beside it. */
  readonly feed: JournalFeed;
  private readonly systemPrompt = memoizeSuccess(() => this.deps.prompt());

  constructor(private readonly deps: AssistantChatDeps) {
    this.readModel = new ChatConversationReadModel({ history: deps.store, repository: deps.repository });
    const scopes: ScopeResolver<AssistantScope> = { resolve: async conversation => scopeOfConversation(conversation) };
    this.runtime = new ChatRuntime<AssistantScope>({
      repository: deps.repository, store: deps.store, scopes, runner: this.runner(),
      admission: { reserve: () => () => undefined },
      toolTimeoutMs: deps.toolTimeoutMs ?? 120_000,
      leaseMs: deps.leaseMs, sweepMs: deps.sweepMs,
      compactionStrategy: deps.compactionStrategy ?? (async () => chatCompactionStrategy(await deps.models.resolve("assistant"), { budget: ASSISTANT_CONTEXT_BUDGET })),
      ...(deps.usage ? { usage: { recorder: deps.usage, attribute: attributeByScope } } : {}),
      ...(deps.usageCap ? { cap: deps.usageCap.guard(payerByScope) } : {})
    });
    this.feed = new JournalFeed({ repository: deps.repository, hub: this.runtime.hub });
    this.gateway = new ServiceChatGateway<AssistantScope>({
      chat: this.runtime.service,
      binders: { account: new AssistantBinder(this), contact: { bind: async () => { throw new ChatError("principal_not_allowed", "Only the Expert reaches the Assistant.", 403); } } },
      parts: deps.chatAssets, uploads: deps.chatAssets, repository: deps.repository, history: deps.store
    });
  }

  start(): Promise<void> { return this.runtime.start(); }

  drain(): Promise<void> { return this.runtime.drain(); }

  /** Hands the Assistant's Runs to another instance. The store and repository belong to whoever made them. */
  async close(): Promise<void> {
    await this.runtime.stop();
  }

  scopeOf(conversation: ConversationRecord): AssistantScope { return scopeOfConversation(conversation); }

  /** The account's conversation, made on first use. Its old history, if it has any, is read in as it is made. */
  conversation(accountId: string): Promise<ConversationRecord> {
    if (!/^[0-9a-f-]{36}$/.test(accountId)) return Promise.reject(new Error("Invalid account ID"));
    let pending = this.conversations.get(accountId);
    if (!pending) {
      const id = assistantConversationId(accountId);
      pending = (async () => {
        await this.deps.history.importInto(accountId, id);
        return (await this.deps.repository.createConversation({
          id, publicId: `conv_${randomUUID().replaceAll("-", "")}`, ownerAccountId: accountId, creatorId: accountId, agentId: ASSISTANT_AGENT_ID,
          productId: ASSISTANT_AGENT_ID, corpusDigest: ASSISTANT_AGENT_ID, clientRequestId: ASSISTANT_AGENT_ID
        })).conversation;
      })();
      this.conversations.set(accountId, pending);
      pending.catch(() => this.conversations.delete(accountId));
    }
    return pending;
  }

  // ── The model's side ───────────────────────────────────────────────────


  private agentRuntime(): AgentRuntime {
    return this.deps.createRuntime?.() ?? new PiAgentRuntime({ env: this.deps.env, models: this.deps.models, role: "assistant" });
  }

  /** Where the Expert last spoke: the origin of what the Assistant starts. */
  private async origin(accountId: string): Promise<TaskOrigin> {
    return { source: (await this.deps.state.lastExpert(accountId))?.source ?? "web" };
  }

  private runner(): TurnRunner<AssistantScope> {
    const { deps } = this;
    return { run: async turn => {
      const { accountId } = turn.scope;
      // Workers the Assistant starts in this Run are the same request's usage.
      if (turn.scope.apiKeyId) bindContext({ api_key_id: turn.scope.apiKeyId });
      try {
        const serverTools = new ServerToolExecutor(deps.toolTimeoutMs ?? 120_000);
        serverTools.setAttachments(deps.chatAssets.toolsFor(turn.conversation));
        serverTools.setStudio(new StudioToolRunner(deps.tools, { accountId, runId: turn.run.id, origin: () => this.origin(accountId) }));
        await runModelTurn(
          turn.input, turn.persistedUser, NO_SKILLS, turn.scope, turn.broker, serverTools,
          new ToolBridge(turn.broker, serverTools, () => turn.clientOf().client),
          this.agentRuntime(),
          deps.store, deps.repository, deps.assetStore, turn.state, async message => turn.publish(message), deps.outputGuard ?? new PassThroughOutputGuard(),
          turn.signal, undefined, undefined, () => undefined, turn.clientOf, turn.claimSteered, turn.onSteer, turn.compaction,
          {
            agent: { systemPrompt: await this.systemPrompt(), localTools: [], externalTools: studioToolNames(deps.tools), externalToolDefinitions: [] },
            liveState: () => deps.liveState(accountId).catch(error => { this.report(accountId, error); return "<当前状态>\n这次没有读到当前状态，需要时用 list_agents 和 list_tasks 查。\n</当前状态>"; }),
            ownPrompt: true, mayStaySilent: true, usage: turn.usage
          }
        );
      } catch (error) { await failRun(turn, error); }
    } };
  }

  // ── Saying and reading ─────────────────────────────────────────────────

  /**
   * The one way the Expert's words reach the Assistant, from Studio or from a chat: steers the active Run with this message or
   * starts one, atomically. `id` is the key a retry reuses. Where the Expert last spoke is recorded once Chat has accepted the
   * message, at the time it accepted it; a replay or a refusal moves nothing.
   */
  async say(accountId: string, input: { id: string; parts: ContentPart[]; origin: { source: LastExpert["source"]; messageRef?: string; client: ClientAttributes } }): Promise<SentMessage> {
    // `sys:` ids are the Assistant's own to itself: a client's key cannot be one, or its message would be hidden as news.
    if (isSystemMessageId(input.id)) throw new ChatError("invalid_message_id", `A message id cannot start with ${SYSTEM_MESSAGE_PREFIX}.`, 400);
    const { source, messageRef, client } = input.origin;
    const sent = await this.submit(accountId, input.id, input.parts, client);
    if (sent.outcome !== "replayed") await this.deps.state.expertSpoke(accountId, { source, at: sent.acceptedAt, ...(messageRef ? { messageRef } : {}) });
    return sent;
  }

  private submit(accountId: string, id: string, parts: ContentPart[], client: ClientAttributes): Promise<SentMessage> {
    return this.gateway.send(accountPrincipal(accountId), { kind: "conversation", id: accountId }, client, id, parts);
  }

  /**
   * Answers the conversation again after a Run that failed or was interrupted. `id` is the key a repeat reuses: the same key is
   * the same Run. Refused (ChatError, 409) while a Run is active or when the latest Run is not failed or interrupted.
   */
  async retry(accountId: string, input: { id: string; client: ClientAttributes }): Promise<Retried> {
    const conversation = await this.conversation(accountId);
    return this.runtime.service.retry({
      principal: accountPrincipal(accountId), conversation, scope: this.scopeOf(conversation), client: input.client, key: input.id,
      runId: `run_${randomUUID().replaceAll("-", "")}`, corpusDigest: conversation.corpusDigest, requiresLocalTools: false
    });
  }

  /** The Assistant's own words to itself: news from its workers, the daily check, Never shown as the Expert's. */
  sayAsSystem(accountId: string, text: string, key: string): Promise<SentMessage> {
    return this.submit(accountId, `${SYSTEM_MESSAGE_PREFIX}${key}`, [{ type: "text", text }], { client: "web" });
  }

  upload(accountId: string, name: string, bytes: Buffer): Promise<UploadedRef> {
    return this.gateway.upload(accountPrincipal(accountId), { kind: "conversation", id: accountId }, { name, bytes });
  }

  /** Resolves once no Run holds the conversation. */
  async idle(accountId: string, timeoutMs = 120_000): Promise<void> {
    const { id } = await this.conversation(accountId);
    const deadline = Date.now() + timeoutMs;
    while (await this.deps.repository.getActiveRun(id)) {
      if (Date.now() > deadline) throw new Error("The Assistant is still busy.");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async activeRun(accountId: string): Promise<ConversationRunRecord | undefined> {
    return this.deps.repository.getActiveRun((await this.conversation(accountId)).id);
  }

  /** An explicit stop: the only thing that ends a Run early. */
  async stop(accountId: string): Promise<void> {
    const run = await this.activeRun(accountId);
    if (run) await this.runtime.cancel(run.conversationId, run.id, "Stopped from Studio");
  }

  async status(accountId: string): Promise<ConversationStatus> {
    const conversation = await this.conversation(accountId);
    const runs = await this.deps.repository.listRuns(conversation.id);
    const last = runs.at(-1);
    if (last && ACTIVE.has(last.status)) return { state: "running", runId: last.id, ...(last.status === "compacting" ? { compacting: true as const } : {}) };
    // Between Runs a summary can still be under way: a refreshed page learns that from here, not from events it missed.
    const compacting = await this.deps.repository.runningCompaction(conversation.id) ? { compacting: true as const } : {};
    // A Run that failed or was interrupted can be answered again, so the page is told which one.
    return last && (last.status === "failed" || last.status === "interrupted") ? { state: "failed", runId: last.id, error: last.failure ?? failureOfReason(undefined), ...compacting } : { state: "idle", ...compacting };
  }

  /**
   * What the Expert and the Assistant said, oldest first, as every Studio client reads a conversation: without `after`, the
   * latest `limit`; with it, the first `limit` after that message. Only as much of the conversation is read as that needs.
   */
  async lines(accountId: string, after?: string, limit = DEFAULT_PAGE): Promise<PublicMessage[]> {
    const size = Math.min(Math.max(Math.trunc(limit) || DEFAULT_PAGE, 1), MAX_PAGE);
    let lines: PublicMessage[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.shown(accountId, { limit: 200, beforeCursor: before });
      lines = [...page.messages, ...lines];
      const found = after === undefined ? lines.length >= size : lines.some(line => line.id === after);
      if (found || !page.has_more) break;
      before = page.before_cursor;
    }
    if (after === undefined) return lines.slice(-size);
    const index = lines.findIndex(line => line.id === after);
    if (index < 0) throw new ConversationError(400, "unknown_cursor", `No message with id ${after} in this conversation.`);
    return lines.slice(index + 1, index + 1 + size);
  }

  /**
   * `lines`, with the steps the Assistant took inside each reply, placed among its words as Chat keeps them: what the Expert's
   * page needs to show a reply as it happened. A step is what Chat shows of a tool call, never its arguments or result.
   * The Assistant's own messages to itself and its silences are not part of the chat.
   */
  async shown(accountId: string, options: { limit?: number; beforeCursor?: string } = {}): Promise<HistoryPage> {
    const conversation = await this.conversation(accountId);
    const { messages: history, ...paging } = await this.readModel.page(conversation.id, options);
    // Only what this page's messages carried: a long conversation costs what one page does.
    const attached = await this.deps.chatAssets.attachments(conversation, history.flatMap(message => message.role === "user" ? [attachmentMessageId(message.id)] : []));
    const byMessage = new Map<string, Array<{ type: "image" | "file" | "audio"; name: string; asset_id: string; bytes: number }>>();
    for (const { asset, messageId } of attached) byMessage.set(messageId, [...byMessage.get(messageId) ?? [], { type: asset.record.kind, name: asset.record.name, asset_id: asset.id, bytes: asset.record.bytes }]);
    const lastOfRun = new Map<string, (typeof history)[number]>();
    for (const message of history) if (message.role === "assistant") lastOfRun.set(message.run_id, message);
    const messages = history.flatMap((message): PublicMessage[] => {
      if (message.role === "user") {
        if (isSystemMessageId(message.id)) return [];
        const attachments = byMessage.get(attachmentMessageId(message.id));
        if (!message.content.trim() && !attachments?.length) return [];
        return [{ id: message.id, role: "user", text: message.content, created_at: message.accepted_at, ...(message.state ? { state: message.state } : {}), ...(attachments?.length ? { attachments } : {}) }];
      }
      // Chat keeps a Run's steps on every assistant message the Run passed through; the reply shows them once, on the last.
      const tools = lastOfRun.get(message.run_id) === message ? message.tool_calls ?? [] : [];
      const reasoned = Boolean(message.parts?.some(part => part.type === "thinking"));
      if (!message.content.trim() && !tools.length) return [];
      const steps = tools.length || reasoned ? { parts: message.parts, tool_calls: tools.map(({ tool_call_id, name, status, activity_message }) => ({ tool_call_id, name, status, activity_message })) } : undefined;
      return [{ id: message.id, role: "assistant", text: message.content, created_at: message.accepted_at, ...(steps ? { steps } : {}) }];
    });
    return { messages, has_more: paging.has_more, ...(paging.before_cursor ? { before_cursor: paging.before_cursor } : {}) };
  }

  /** The newest `limit` messages (at most 200), or the page before `before`: how the Expert's page reads back through a long conversation. */
  async history(accountId: string, { limit, before }: { limit?: number; before?: string } = {}): Promise<HistoryPage> {
    try { return await this.shown(accountId, { limit: Number.isInteger(limit) && limit! > 0 ? Math.min(limit!, 200) : 200, beforeCursor: before }); }
    catch (error) { throw error instanceof HistoryCursorError ? new ConversationError(400, "history_cursor_invalid", "Invalid conversation history cursor.") : error; }
  }

  async send(accountId: string, input: SendInput): Promise<Sent> {
    const conversation = await this.conversation(accountId);
    const before = await this.deps.repository.getActiveRun(conversation.id);
    // A voice message already is its transcript in the text: the asset itself is bound to the message, not read again.
    const transcripts = input.attachments.flatMap(asset => asset.kind === "audio" && asset.transcript ? [asset.transcript] : []);
    const text = transcripts.reduce((rest, transcript) => rest.replace(transcript, ""), input.text).trim();
    const parts: ContentPart[] = [...(text ? [{ type: "text" as const, text }] : []), ...input.attachments.map(asset => ({ type: asset.kind, assetId: asset.id }))];
    try {
      const sent = await this.say(accountId, { id: input.id, parts, origin: { source: "web", client: input.client } });
      return {
        conversationId: accountId, queued: Boolean(before), runId: sent.runId,
        message: { id: input.id, role: "user", text: input.text, created_at: sent.acceptedAt, ...(input.attachments.length ? { attachments: input.attachments.map(asset => ({ type: asset.kind, name: asset.name, asset_id: asset.id })) } : {}) }
      };
    } catch (error) { throw refusedAs(error); }
  }

  feedKey(accountId: string): string { return assistantFeedKey(accountId); }

  conversationId(accountId: string): string { return assistantConversationId(accountId); }

  assets(): AssetDesk { return this.deps.chatAssets.studioDesk(); }

  /** Tells Studio observers the Assistant changed in a way no Run shows, such as a chat being linked. */
  async touch(accountId: string): Promise<void> { this.runtime.hub.publish(assistantConversationId(accountId), { type: "studio.touched" }); }

  /** What the running turn has said so far: from the live text when this process has it, else from what the Run last saved. */
  async partial(accountId: string): Promise<string> {
    const conversation = await this.conversation(accountId);
    const live = this.runtime.hub.catchUp(conversation.id)?.delta as { content?: string } | undefined;
    return live?.content ?? (await this.deps.repository.getActiveRun(conversation.id))?.partialOutput ?? "";
  }

  accountOf(conversationId: string): string | undefined { return accountOfConversation(conversationId); }

  private report(accountId: string, error: unknown): void { (this.deps.report ?? ((id, cause) => log.error("assistant_failed", { account: id, error: cause })))(accountId, error); }
}

/** Studio shows a refusal from Chat as its own, with the status and code Studio's clients know. */
function refusedAs(error: unknown): unknown {
  if (!(error instanceof ChatError)) return error;
  const code = error.code === "client_message_conflict" ? "idempotency_conflict" : error.code;
  return new ConversationError(error.status, code, error.message);
}
