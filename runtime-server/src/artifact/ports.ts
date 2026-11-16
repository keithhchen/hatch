/** Artifact mode: a product whose buyer fills one intake form and receives one rendered report instead of chatting. */

export type RenderedReport = { fullPdf: Buffer; freePdf: Buffer; preview: Buffer /* PNG */ };

/** Turns the report's HTML into its PDFs and a blurred preview. Adapter: headless Chromium in the Runtime; tests use a double. */
export interface ReportRenderer {
  render(input: { fullHtml: string; freeHtml: string }, signal?: AbortSignal): Promise<RenderedReport>;
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
export type ReportKeys = { fullHtml: string; freeHtml: string; fullPdf: string; freePdf: string; preview: string };
export type ReportStep = { at: string; stage: ReportStage; detail?: string };
export const MAX_REPORT_STEPS = 20;
export const MAX_REPORT_ATTEMPTS = 3;
/** Wait before attempt 2 and before attempt 3. */
export const RETRY_BACKOFF_MS = [30_000, 120_000] as const;

export type ReportRecord = {
  conversationId: string;
  productId: string;
  ownerAccountId: string;
  status: ReportStatus;
  stage: ReportStage;
  /** 1-based; every write about a Run is conditioned on the attempt (or Run) it belongs to. */
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
  /** One UPDATE: the new keys, status 'ready', stage, ready_at. A publish after a publish replaces the files as one unit. Only for the attempt that publishes. */
  ready(conversationId: string, attempt: number, keys: ReportKeys, now: Date): Promise<ReportRecord | undefined>;
  /**
   * The Run ended with no report published. If its attempt was not the last, the next is due after the backoff; otherwise the report
   * fails. Matches only the current Run of a draft or generating report: a late end of an older attempt changes nothing.
   */
  runEnded(runId: string, reason: string, now: Date): Promise<ReportRecord | undefined>;
  /** The attempts that are due, as (conversation, attempt) pairs to claim. */
  due(now: Date): Promise<Array<{ conversationId: string; attempt: number }>>;
  /** Compare-and-set on the attempt: attempt + 1, this new Run, a lease. Undefined when another instance claimed it first. */
  claim(conversationId: string, attempt: number, runId: string, now: Date, leaseMs: number): Promise<ReportRecord | undefined>;
  /** The pilot's manual unlock: one UPDATE. */
  unlock(conversationId: string): Promise<void>;
}
