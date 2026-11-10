import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "../agentRuntime.js";
import { PiAgentRuntime } from "../piAgentRuntime.js";
import type { RuntimeAssetStore } from "../assetStore.js";
import type { CompactionStrategy } from "../compactionStrategy.js";
import type { RuntimeCompactionMessage } from "../compaction.js";
import type { ConversationRecord, ConversationRepository, ConversationRunRecord } from "../conversationRepository.js";
import { failureOfReason } from "../errors/failures.js";
import { ChatAssets, attachmentMessageId } from "../chat/assets.js";
import type { ChatGateway, ConversationRef, SentMessage } from "../chat/gateway.js";
import { ChatRuntime } from "../chat/chatRuntime.js";
import { NO_SKILLS, failRun, runModelTurn, type TurnBinding } from "../chat/modelTurn.js";
import { ChatError, accountPrincipal } from "../chat/principal.js";
import { ServiceChatGateway, type PrincipalBinder } from "../chat/serviceGateway.js";
import type { ScopeResolver, TurnRunner } from "../chat/turnExecutor.js";
import { ConversationError, type ConversationStatus, type PublicMessage, type SendInput, type Sent } from "../conversations/conversation.js";
import type { EventLog } from "../conversations/eventLog.js";
import { PassThroughOutputGuard, type OutputGuard } from "../outputGuard.js";
import { ServerToolExecutor } from "../serverTools.js";
import type { RuntimeStore } from "../store.js";
import { ToolBridge } from "../toolBridge.js";
import type { ClientAttributes, ContentPart } from "../surfaces/contract.js";
import { InterviewRelay, isRelayed, isSystemMessageId, SYSTEM_MESSAGE_PREFIX, type InterviewDesk } from "./relay.js";
import type { AssistantStateRepository } from "./state.js";
import { StudioEventProjection, StudioHub, accountOfConversation, assistantConversationId, assistantFeedKey } from "./studioFeed.js";
import { StudioToolRunner, studioToolNames, type StudioTool } from "./studioTools.js";
import type { TaskOrigin } from "./tasks.js";
import type { LegacyAssistantHistory } from "./history.js";
import type { AssistantHost } from "../conversations/assistantConversation.js";
import type { AssetDesk } from "../conversations/assets.js";

/** The Assistant is one Agent, not a Product: its conversation is bound to the account, under this id. */
export const ASSISTANT_AGENT_ID = "assistant";
const ASSISTANT_PROFILE = "kimi-k2.6-no-thinking";
const ACTIVE = new Set(["queued", "running", "waiting_for_tool", "compacting"]);

/** What a Run of the Assistant needs beyond the binding every Chat Run has. */
export type AssistantScope = TurnBinding & { accountId: string };

export type AssistantChatDeps = {
  repository: ConversationRepository;
  /** The transcript store, whose final assistant messages are committed with the `message_end` Studio shows. */
  store: RuntimeStore & { projection?: StudioEventProjection };
  eventLog: EventLog;
  assetStore: RuntimeAssetStore;
  chatAssets: ChatAssets;
  state: AssistantStateRepository;
  tools: readonly StudioTool[];
  desk: InterviewDesk;
  history: Pick<LegacyAssistantHistory, "importInto">;
  /** The Assistant's whole system prompt. */
  prompt: () => Promise<string>;
  /** What the Assistant sees of the Expert's Agents and tasks right now; rebuilt for every model call. */
  liveState: (accountId: string) => Promise<string>;
  env: NodeJS.ProcessEnv;
  /** Replaces the model, for tests. */
  createRuntime?: () => AgentRuntime;
  outputGuard?: OutputGuard;
  compactionStrategy?: () => CompactionStrategy<RuntimeCompactionMessage>;
  toolTimeoutMs?: number;
  leaseMs?: number;
  sweepMs?: number;
  report?: (accountId: string, error: unknown) => void;
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

const scopeOfConversation = (conversation: Pick<ConversationRecord, "ownerAccountId">): AssistantScope => ({
  creatorId: conversation.ownerAccountId, userId: conversation.ownerAccountId, productId: ASSISTANT_AGENT_ID, corpusDigest: ASSISTANT_AGENT_ID, accountId: conversation.ownerAccountId
});

/**
 * The Assistant as a conversation on Chat's runtime: the same Runs, steering, resume, compaction, idempotency and
 * attachments as a Product's, with the Studio tools and the Assistant's own prompt. It is hosted here, in the process that
 * holds the Expert's Products and tasks, so its tools are calls rather than requests.
 */
export class AssistantChat implements AssistantHost {
  readonly runtime: ChatRuntime<AssistantScope>;
  readonly gateway: ChatGateway;
  private readonly conversations = new Map<string, Promise<ConversationRecord>>();
  private prompt?: Promise<string>;

  constructor(private readonly deps: AssistantChatDeps) {
    const projection = new StudioEventProjection(deps.eventLog);
    deps.store.projection = projection;
    const scopes: ScopeResolver<AssistantScope> = { resolve: async conversation => scopeOfConversation(conversation) };
    this.runtime = new ChatRuntime<AssistantScope>({
      repository: deps.repository, store: deps.store, scopes, runner: this.runner(),
      admission: { reserve: () => () => undefined },
      toolTimeoutMs: deps.toolTimeoutMs ?? 120_000,
      leaseMs: deps.leaseMs, sweepMs: deps.sweepMs,
      hub: new StudioHub(projection),
      ...(deps.compactionStrategy ? { compactionStrategy: deps.compactionStrategy } : {})
    });
    this.gateway = new ServiceChatGateway<AssistantScope>({
      chat: this.runtime.service,
      binders: { account: new AssistantBinder(this), contact: { bind: async () => { throw new ChatError("principal_not_allowed", "Only the Expert reaches the Assistant.", 403); } } },
      parts: deps.chatAssets, uploads: deps.chatAssets, repository: deps.repository, history: deps.store
    });
  }

  start(): Promise<void> { return this.runtime.start(); }

  /** Hands the Assistant's Runs to another instance, and lets go of its storage. */
  async close(): Promise<void> {
    await this.runtime.stop();
    await this.deps.store.close();
    await this.deps.repository.close();
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

  private systemPrompt(): Promise<string> { return this.prompt ??= this.deps.prompt(); }

  private agentRuntime(): AgentRuntime {
    return this.deps.createRuntime?.() ?? new PiAgentRuntime({ env: { ...this.deps.env, HATCH_LLM_PROFILE: ASSISTANT_PROFILE } });
  }

  /** Where the Expert last spoke: the origin of what the Assistant starts. */
  private async origin(accountId: string): Promise<TaskOrigin> {
    return { source: (await this.deps.state.lastExpert(accountId))?.source ?? "web" };
  }

  private runner(): TurnRunner<AssistantScope> {
    const { deps } = this;
    return { run: async turn => {
      const { accountId } = turn.scope;
      try {
        const serverTools = new ServerToolExecutor(deps.toolTimeoutMs ?? 120_000);
        serverTools.setAttachments(deps.chatAssets.toolsFor(turn.conversation));
        serverTools.setStudio(new StudioToolRunner(deps.tools, { accountId, runId: turn.run.id, origin: () => this.origin(accountId) }));
        const relayed = isRelayed(turn.input.message.content, Boolean(await deps.state.interview(accountId)));
        await runModelTurn(
          turn.input, turn.persistedUser, NO_SKILLS, turn.scope, turn.broker, serverTools,
          new ToolBridge(turn.broker, serverTools, () => turn.clientOf().client),
          relayed ? new InterviewRelay({ accountId, state: deps.state, desk: deps.desk }) : this.agentRuntime(),
          deps.store, deps.repository, deps.assetStore, turn.state, async message => turn.publish(message), deps.outputGuard ?? new PassThroughOutputGuard(),
          turn.signal, undefined, undefined, () => undefined, turn.clientOf, turn.claimSteered, turn.compaction,
          {
            agent: { systemPrompt: await this.systemPrompt(), localTools: [], externalTools: studioToolNames(deps.tools), externalToolDefinitions: [] },
            liveState: () => deps.liveState(accountId).catch(error => { this.report(accountId, error); return "<当前状态>\n这次没有读到当前状态，需要时用 list_agents 和 list_tasks 查。\n</当前状态>"; }),
            ownPrompt: true, mayStaySilent: true
          }
        );
      } catch (error) { await failRun(turn, error); }
    } };
  }

  // ── Saying and reading ─────────────────────────────────────────────────

  /** Steers the Assistant's active Run with this message or starts one, atomically. `id` is the key a retry reuses. */
  async say(accountId: string, input: { id: string; parts: ContentPart[]; client: ClientAttributes }): Promise<SentMessage> {
    return this.gateway.send(accountPrincipal(accountId), { kind: "conversation", id: accountId }, input.client, input.id, input.parts);
  }

  /** The Assistant's own words to itself: news from its workers, the daily check, an interview's reply. Never shown as the Expert's. */
  sayAsSystem(accountId: string, text: string, key: string = randomUUID()): Promise<SentMessage> {
    return this.say(accountId, { id: `${SYSTEM_MESSAGE_PREFIX}${key}`, parts: [{ type: "text", text }], client: { client: "web" } });
  }

  upload(accountId: string, name: string, bytes: Buffer): Promise<{ assetId: string }> {
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
    if (!last) return { state: "idle" };
    if (ACTIVE.has(last.status)) return { state: "running", runId: last.id };
    return last.status === "failed" ? { state: "failed", error: failureOfReason(last.interruptedReason) } : { state: "idle" };
  }

  /** What the Expert and the Assistant said, oldest first. The Assistant's own messages to itself and its silences are not part of the chat. */
  async lines(accountId: string): Promise<PublicMessage[]> {
    const conversation = await this.conversation(accountId);
    const [history, attached] = await Promise.all([this.deps.store.readVisibleConversation(conversation.id), this.deps.chatAssets.attachments(conversation)]);
    const byMessage = new Map<string, Array<{ type: "image" | "file" | "audio"; name: string; asset_id: string }>>();
    for (const { asset, messageId } of attached) byMessage.set(messageId, [...byMessage.get(messageId) ?? [], { type: asset.record.kind, name: asset.record.name, asset_id: asset.id }]);
    const counts = new Map<string, number>();
    return history.flatMap((message): PublicMessage[] => {
      if (message.role === "user") {
        if (!message.id || isSystemMessageId(message.id) || !message.content.trim()) return [];
        const attachments = byMessage.get(attachmentMessageId(message.id));
        return [{ id: message.id, role: "user", text: message.content, created_at: message.timestamp, ...(attachments?.length ? { attachments } : {}) }];
      }
      if (!message.content.trim()) return [];
      const index = (counts.get(message.run_id) ?? 0) + 1;
      counts.set(message.run_id, index);
      return [{ id: `${message.run_id}:${index}`, role: "assistant", text: message.content, created_at: message.timestamp }];
    });
  }

  async send(accountId: string, input: SendInput): Promise<Sent> {
    const conversation = await this.conversation(accountId);
    const before = await this.deps.repository.getActiveRun(conversation.id);
    // A voice message already is its transcript in the text: the asset itself is bound to the message, not read again.
    const transcripts = input.attachments.flatMap(asset => asset.kind === "audio" && asset.transcript ? [asset.transcript] : []);
    const text = transcripts.reduce((rest, transcript) => rest.replace(transcript, ""), input.text).trim();
    const parts: ContentPart[] = [...(text ? [{ type: "text" as const, text }] : []), ...input.attachments.map(asset => ({ type: asset.kind, assetId: asset.id }))];
    try {
      await this.deps.state.expertSpoke(accountId, { source: "web", at: new Date().toISOString() });
      const sent = await this.say(accountId, { id: input.id, parts, client: input.client });
      return {
        conversationId: accountId, queued: Boolean(before), runId: sent.runId,
        message: { id: input.id, role: "user", text: input.text, created_at: new Date().toISOString(), ...(input.attachments.length ? { attachments: input.attachments.map(asset => ({ type: asset.kind, name: asset.name, asset_id: asset.id })) } : {}) }
      };
    } catch (error) { throw refusedAs(error); }
  }

  feedKey(accountId: string): string { return assistantFeedKey(accountId); }

  conversationId(accountId: string): string { return assistantConversationId(accountId); }

  assets(): AssetDesk { return this.deps.chatAssets.studioDesk(); }

  /** Tells Studio observers the Assistant changed in a way no Run shows, such as a chat being linked. */
  async touch(accountId: string): Promise<void> { await this.deps.eventLog.append(assistantFeedKey(accountId), { type: "state" }); }

  /** The pixels of a picture the Expert sent, for the chat page. */
  async image(accountId: string, assetId: string): Promise<{ bytes: Buffer; mime: string } | undefined> {
    const conversation = await this.conversation(accountId);
    const found = (await this.deps.chatAssets.attachments(conversation)).find(({ asset }) => asset.id === assetId && asset.record.kind === "image");
    const resized = found?.asset.derivative("resized");
    const bytes = found && resized ? await this.deps.chatAssets.derivative(found.asset, "resized") : undefined;
    return bytes && resized ? { bytes, mime: resized.mime } : undefined;
  }

  accountOf(conversationId: string): string | undefined { return accountOfConversation(conversationId); }

  private report(accountId: string, error: unknown): void { (this.deps.report ?? ((id, cause) => console.error(`[assistant ${id}]`, cause)))(accountId, error); }
}

/** Studio shows a refusal from Chat as its own, with the status and code Studio's clients know. */
function refusedAs(error: unknown): unknown {
  if (!(error instanceof ChatError)) return error;
  const code = error.code === "client_message_conflict" ? "idempotency_conflict" : error.code;
  return new ConversationError(error.status, code, error.message);
}
