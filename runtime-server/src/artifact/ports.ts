/** Artifact mode: a product whose buyer fills one intake form and receives one rendered report instead of chatting. */
import type { AssetBlobs } from "../assets/domain.js";
import type { ArtifactObjectStore } from "../creatorLearning/objectStore.js";

/** Where a report's files are kept. A store that can presign lets a browser fetch them straight from it. */
export type ReportBlobs = AssetBlobs & Partial<Pick<ArtifactObjectStore, "presign">>;

/** `pageImages` (WebP, one per page, in order) is present only when every page was asked for. */
export type RenderedReport = { pdf: Buffer; pages: number; firstPagePng: Buffer; pageImages?: Buffer[] };

/** Turns a report document's HTML into its PDF, the PDF's page count and its first page as a PNG; with `pages: "all"`, every page as a WebP too. Adapter: headless Chromium in the Runtime; tests use a double. */
export interface ReportRenderer {
  render(html: string, options: { pages: "first" | "all"; signal?: AbortSignal }): Promise<RenderedReport>;
}

/** One string, or the same text per language. */
export type LocalizedText = string | Partial<Record<"zh" | "en" | "ja", string>>;

export type IntakeField = {
  id: string;
  label: LocalizedText;
  type: "text" | "long_text" | "choice" | "multi" | "files";
  required?: boolean;
  options?: LocalizedText[];
  help?: LocalizedText;
};
export type Intake = { fields: IntakeField[] };

/** What a product in artifact mode is configured with. `reportTemplate` is the agent's, never the buyer's. */
export type ArtifactConfig = { productId: string; intake: Intake; reportTemplate: string };

/** A product is in artifact mode iff it has a config. A malformed config is an error, not an absence. */
export interface ArtifactConfigRepository {
  get(productId: string): Promise<ArtifactConfig | undefined>;
}

export type ReportStatus = "draft" | "generating" | "ready" | "failed";
export type ReportStage = "queued" | "reading" | "consulting" | "researching" | "writing" | "proofreading" | "rendering" | "ready" | "failed";
/** The report is written in two phases: the one-page summary first, the full report once the parent unlocks it. */
export type ReportPhase = "summary" | "full";
export type ReportKeys = { summaryHtml?: string; summaryPdf?: string; summaryPng?: string; fullHtml?: string; fullPdf?: string; fullPages?: string[] };
export type ReportStep = { at: string; stage: ReportStage; detail?: string };
export const MAX_REPORT_STEPS = 20;
/**
 * A report is up to this many Runs of one conversation. A Run that ends without publishing is not a failure: the
 * conversation simply continues with the next Run, shortly after. Only the last Run's end fails the report.
 */
export const MAX_REPORT_ATTEMPTS = 5;
/** The pause before the next Run continues the conversation. */
export const CONTINUE_DELAY_MS = 5_000;

export type ReportRecord = {
  conversationId: string;
  productId: string;
  ownerAccountId: string;
  status: ReportStatus;
  stage: ReportStage;
  phase: ReportPhase;
  /** 1-based, per phase; every write about a Run is conditioned on the attempt (or Run) it belongs to. */
  attempt: number;
  /** The Run of the current attempt. */
  runId?: string;
  error?: string;
  keys?: ReportKeys;
  steps: ReportStep[];
  createdAt: string;
  startedAt?: string;
  readyAt?: string;
  unlockedAt?: string;
  /** When the next attempt may start (or, once claimed, the lease after which an attempt that never started is claimed again). */
  retryAt?: string;
};

/**
 * A conversation is an artifact conversation iff it has a report row here. Every transition is one conditional write, so
 * concurrent instances and late Runs cannot leave a half state or overwrite a newer attempt.
 */
export interface ReportRepository {
  initialize(): Promise<void>;
  get(conversationId: string): Promise<ReportRecord | undefined>;
  /** Which of these conversations are report conversations. */
  reportConversations(conversationIds: string[]): Promise<Set<string>>;
  /** A new artifact conversation's report, 'draft'. Creating it again changes nothing. */
  create(input: { conversationId: string; productId: string; ownerAccountId: string }): Promise<ReportRecord>;
  /** The owner's reports for a product, newest first. */
  list(ownerAccountId: string, productId: string): Promise<ReportRecord[]>;
  /** The first message's Run was accepted: a draft (or a failed report asked for again) becomes 'generating', attempt 1, with this Run. For the current Run it only clears the claim lease. Else nothing. */
  begin(conversationId: string, runId: string, now: Date): Promise<ReportRecord | undefined>;
  /** A step of the attempt: sets the stage and appends to the last steps. Only while that attempt is generating. */
  progress(conversationId: string, attempt: number, stage: ReportStage, detail: string | undefined, now: Date): Promise<void>;
  /** One UPDATE: the phase's keys merged into the row's, status 'ready', stage, ready_at. A publish after a publish replaces that phase's files as one unit. Only for the attempt of that phase that publishes. */
  ready(conversationId: string, attempt: number, phase: ReportPhase, keys: ReportKeys, now: Date): Promise<ReportRecord | undefined>;
  /**
   * The Run ended with no report published. If its attempt was not the last, the next is due after the backoff; otherwise the report
   * fails. Matches only the current Run of a draft or generating report: a late end of an older attempt changes nothing.
   */
  runEnded(runId: string, reason: string, now: Date): Promise<ReportRecord | undefined>;
  /** The attempts that are due, as (conversation, attempt) pairs to claim. */
  due(now: Date): Promise<Array<{ conversationId: string; attempt: number }>>;
  /** Compare-and-set on the attempt: attempt + 1, this new Run, a lease. Undefined when another instance claimed it first. */
  claim(conversationId: string, attempt: number, runId: string, now: Date, leaseMs: number): Promise<ReportRecord | undefined>;
  /**
   * The parent unlocks the full report: one conditional UPDATE from (summary, ready) to (full, generating, queued, attempt 1) with
   * this new Run. Undefined when the report is in any other state, so only one caller wins.
   */
  unlock(conversationId: string, runId: string, now: Date): Promise<ReportRecord | undefined>;
}
