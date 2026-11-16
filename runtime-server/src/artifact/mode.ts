import { REPLY_LANGUAGE_RULE } from "../agentRuntime.js";
import type { ProductAnalytics } from "../analytics/port.js";
import { safely } from "../analytics/safe.js";
import type { AssetBlobs } from "../assets/domain.js";
import type { ChatAssets } from "../chat/assets.js";
import type { ConversationRecord, ConversationRunRecord } from "../conversationRepository.js";
import { ConversationError } from "../conversations/conversation.js";
import type { HostToolRunner } from "../serverTools.js";
import { ArtifactLifecycle } from "./lifecycle.js";
import type { ArtifactConfigRepository, ReportRenderer, ReportRepository } from "./ports.js";
import { artifactPrompt } from "./prompt.js";
import { ReportProgress } from "./progress.js";
import { ReportPublisher } from "./publisher.js";
import { DRAFT_TOOLS, PUBLISH_REPORT_TOOL, WEB_SEARCH_TOOL, reportToolRunner } from "./toolDefinitions.js";
import { InMemoryDraftStore, type DraftStore } from "./drafts.js";
import type { SearchProvider } from "../factoryAgents/search.js";

/** At most this many files may be uploaded to one artifact conversation. */
export const MAX_ARTIFACT_FILES = 20;

/** What a Run of an artifact conversation has beyond a chat Run. */
export type ArtifactTurn = { promptSuffix: string; extraTools: string[]; tools: HostToolRunner; onTool: ReportProgress["onTool"]; turnReminder: (now: Date) => string; toolCallLimit: { max: number; uncounted: string[] } };

/** A report reads far more than a chat reply: the form, every file, the knowledge base. Its delivery never counts, so it is always callable. */
export const REPORT_TOOL_CALL_LIMIT = { max: 100, uncounted: ["publish_report"] };

/**
 * When a report Run summarizes its context. At 120k it summarized eleven times in one report: every summary is a model
 * call, and the records it drops get read again. With a 1M window, 750k lets a report run whole, and
 * the notes file keeps what matters if it does.
 */
export const REPORT_CONTEXT_BUDGET = { trigger: 750_000, prune: 600_000, tail: 80_000, hard: 950_000 } as const;

/**
 * The last thing the model reads on every call of a report Run, in place of the chat reply reminder: a buyer chat reply
 * is one to three sentences, a report Run never replies in chat, so the chat reminder must not reach it.
 */
export const reportTurnReminder = (now: Date): string => [
  "<system-reminder>",
  `Current time: ${now.toISOString()}`,
  "This is report mode, not a chat. Nobody will answer a question: do not ask one and do not write a chat reply. Read the form and the files, consult your knowledge, then deliver the whole report by calling publish_report once. Your Run is finished only when publish_report has returned \"Report published.\".",
  REPLY_LANGUAGE_RULE,
  "</system-reminder>"
].join("\n");

/**
 * Artifact mode as the Runtime composes it. A product offers it with a config row; a conversation is an artifact
 * conversation iff it has a report row, so a product's chat conversations are untouched.
 */
export class ArtifactMode {
  readonly lifecycle: ArtifactLifecycle;
  readonly publisher: ReportPublisher;

  constructor(readonly deps: {
    configs: ArtifactConfigRepository;
    reports: ReportRepository;
    renderer: ReportRenderer;
    blobs: AssetBlobs;
    assets: Pick<ChatAssets, "uploadedCount">;
    analytics?: ProductAnalytics;
    maxFiles?: number;
    /** The public web, for facts that change; absent when the server has no search configured. */
    search?: SearchProvider;
    /** The report's working files; in memory when not given (tests). */
    drafts?: DraftStore;
    /** Test seams of publishing: pauses, sleep, clock, ids. */
    publishing?: Partial<ConstructorParameters<typeof ReportPublisher>[0]>;
    clock?: () => Date;
  }) {
    const analytics = safely(deps.analytics);
    this.lifecycle = new ArtifactLifecycle(deps.reports, analytics, deps.clock);
    this.drafts = deps.drafts ?? new InMemoryDraftStore();
    this.publisher = new ReportPublisher({ reports: deps.reports, renderer: deps.renderer, blobs: deps.blobs, analytics, ...deps.publishing });
  }

  private readonly drafts: DraftStore;
  get configs() { return this.deps.configs; }
  get reports() { return this.deps.reports; }
  get blobs() { return this.deps.blobs; }

  /** Refuses an upload that would pass the cap, for an artifact conversation only. Returns whether it is one. */
  async assertCanUpload(conversation: Pick<ConversationRecord, "id" | "ownerAccountId">): Promise<boolean> {
    if (!await this.deps.reports.get(conversation.id)) return false;
    const max = this.deps.maxFiles ?? MAX_ARTIFACT_FILES;
    if (await this.deps.assets.uploadedCount(conversation) >= max) throw new ConversationError(413, "too_many_files", `A report takes at most ${max} files.`);
    return true;
  }

  /** The chat list leaves report conversations out: they open on their own page. */
  async withoutReports<T extends { id: string }>(conversations: T[]): Promise<T[]> {
    const reports = await this.deps.reports.reportConversations(conversations.map(conversation => conversation.id));
    return conversations.filter(conversation => !reports.has(conversation.id));
  }

  /** The turn's additions when the conversation is an artifact conversation; otherwise nothing. */
  async turnFor(conversation: ConversationRecord, run: Pick<ConversationRunRecord, "createdAt">): Promise<ArtifactTurn | undefined> {
    const report = await this.deps.reports.get(conversation.id);
    if (!report) return undefined;
    const config = await this.deps.configs.get(conversation.productId);
    if (!config) throw new Error(`Product ${conversation.productId} has an artifact conversation but no artifact configuration.`);
    const progress = new ReportProgress(this.deps.reports, { conversationId: conversation.id, attempt: report.attempt });
    return { promptSuffix: await artifactPrompt(config), extraTools: [PUBLISH_REPORT_TOOL, ...DRAFT_TOOLS, ...(this.deps.search ? [WEB_SEARCH_TOOL] : [])], tools: reportToolRunner(this.publisher, conversation, run, report.attempt, progress, this.drafts, this.deps.search), onTool: progress.onTool, turnReminder: reportTurnReminder, toolCallLimit: REPORT_TOOL_CALL_LIMIT };
  }
}
