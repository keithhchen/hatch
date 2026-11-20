import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AccessGate } from "../accessGate.js";
import type { AgentCorpusResolverLike } from "../agentCorpus.js";
import { BriefValidationError, briefAnswer, briefEmail, createBriefSnapshot, type BriefSpec } from "../brief.js";
import { ChatError } from "../chat/principal.js";
import { conversationBinding, durableConversationId } from "../chat/sessionBinding.js";
import type { ConversationRecord, ConversationRepository } from "../conversationRepository.js";

/** What a person sees at /c/<code>: the entry, the intake form, the wait, the report, or a plain failure. */
export type CodePageState = "entry" | "intake" | "generating" | "ready" | "failed";
export type CodePageStatus = {
  state: CodePageState;
  /** Entry only: why the code did not open a page. */
  reason?: "not_found" | "not_paid" | "used_elsewhere";
  product?: { id: string; name: string };
  /** The expert whose Product it is, for the page header. */
  creator?: { name: string };
  /** What the buyer asked to be diagnosed, as they gave it (the Brief's `website`); known once the intake is in. */
  website?: string;
  /** Intake only: what to ask. The access code is not asked: the page's own address is it. */
  fields?: Array<{ id: string; label: string; required: boolean; type?: string }>;
  /** Generating only: the steps the Product's own mapping names, and which one the Run has reached (-1: none yet). */
  steps?: Array<{ id: string; label: string }>;
  step?: number;
  /** Generating only: where the report will be mailed (the Brief's email), as the buyer gave it. */
  email?: string;
  /** Generating only: when the code was spent and the Run began (the conversation's creation, ISO), for the page's countdown. */
  started_at?: string;
  report_url?: string;
};

/** The Product's own map from what its Run does to steps a person understands: `runtime/progress.json` in its Corpus. */
export type ProgressMap = { steps: Array<{ id: string; label: string; tools: string[] }> };

export async function readProgressMap(corpusRoot: string | undefined): Promise<ProgressMap | undefined> {
  if (!corpusRoot) return undefined;
  try {
    const parsed = JSON.parse(await readFile(path.join(corpusRoot, "runtime", "progress.json"), "utf8")) as ProgressMap;
    return Array.isArray(parsed.steps) ? parsed : undefined;
  } catch { return undefined; }
}

/** The Agent's own introduction on the landing: `runtime/landing.json` in its Corpus. Any field may be absent; nothing is made up for it. */
export type LandingCopy = { agent_name?: string; hook?: string; cta?: string };

export async function readLandingCopy(corpusRoot: string | undefined): Promise<LandingCopy | undefined> {
  if (!corpusRoot) return undefined;
  try {
    const parsed = JSON.parse(await readFile(path.join(corpusRoot, "runtime", "landing.json"), "utf8")) as Record<string, unknown>;
    const text = (key: string) => typeof parsed[key] === "string" && (parsed[key] as string).trim() ? { [key]: (parsed[key] as string).trim() } : {};
    return { ...text("agent_name"), ...text("hook"), ...text("cta") };
  } catch { return undefined; }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const normalizeCode = (code: string) => code.trim().toUpperCase();
/** One conversation per code, named by the code: the same code always means the same conversation. */
export const codeConversationId = (code: string) => `conv_${hash(`code-page:${normalizeCode(code)}`).slice(0, 32)}`;
export const codeOwner = (code: string) => `code:${normalizeCode(code)}`;
export const codeIntakeKey = (code: string) => `code-intake:${normalizeCode(code)}`;

export type CodePagesDeps = {
  gate: AccessGate;
  corpora: AgentCorpusResolverLike;
  repository: ConversationRepository;
  /** The distinct names of the tools the conversation's Runs have called: names only, never arguments or results. */
  store: { toolNames(conversationId: string): Promise<string[]> };
  /** The signed link of the page the code's buyer published since the conversation began. */
  reportUrl(conversation: ConversationRecord): Promise<string | undefined>;
  /** Starts the Run of the Brief, under `key`: the same key again is the same Run. */
  start(conversation: ConversationRecord, key: string): Promise<unknown>;
  /** What one code costs, in fen (HATCH_PAY_PRICE_FEN); absent when payment is not configured. */
  priceFen?: number;
  /** How long a code's status is reused (the page polls every few seconds), and how long a Product's corpus and progress map are. */
  statusTtlMs?: number;
  corpusTtlMs?: number;
  clock?: () => number;
};

/**
 * The page of an access code. The code is the buyer's only credential and it opens exactly one conversation, which the buyer never
 * sees: they submit the intake, wait, and receive the report. Everything here is by the code; a Product without the access code
 * capability is not found.
 */
export class CodePages {
  private readonly statuses = new Map<string, { at: number; value: Promise<CodePageStatus> }>();
  private readonly corpora = new Map<string, { at: number; value: Promise<{ resolved: Awaited<ReturnType<AgentCorpusResolverLike["resolveByProduct"]>>; map: ProgressMap | undefined }> }>();
  constructor(private readonly deps: CodePagesDeps) {}

  /** The product page before any code: what is sold, in the Product's own words, and for how much. */
  async landing(productId: string): Promise<{ product: { id: string; name: string; description?: string }; creator: { name: string }; landing?: LandingCopy; price_fen?: number }> {
    const resolved = await this.deps.corpora.resolveByProduct(productId);
    const { product, creator } = resolved.corpus;
    const copy = await readLandingCopy(resolved.root);
    return { creator: { name: creator.name }, ...(copy ? { landing: copy } : {}), product: { id: productId, name: product.name, ...(product.description ?? product.promise ? { description: product.description ?? product.promise } : {}) }, ...(this.deps.priceFen ? { price_fen: this.deps.priceFen } : {}) };
  }

  private cached<V>(cache: Map<string, { at: number; value: Promise<V> }>, key: string, ttlMs: number, read: () => Promise<V>): Promise<V> {
    const now = (this.deps.clock ?? Date.now)();
    const hit = cache.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
    if (cache.size > 1000) cache.clear();
    const value = read();
    cache.set(key, { at: now, value });
    value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
    return value;
  }

  private resolved(productId: string) {
    return this.cached(this.corpora, productId, this.deps.corpusTtlMs ?? 60_000, async () => {
      const resolved = await this.deps.corpora.resolveByProduct(productId);
      return { resolved, map: await readProgressMap(resolved.root) };
    });
  }

  /** The page polls every few seconds: callers of the same code share one read for a few seconds. */
  status(rawCode: string): Promise<CodePageStatus> {
    const code = normalizeCode(rawCode);
    const status = this.cached(this.statuses, code, this.deps.statusTtlMs ?? 5_000, () => this.read(code));
    // The entry and the intake are not waited on: they change the moment a payment or an intake lands, so they are never reused.
    void status.then((value) => { if (value.state === "entry" || value.state === "intake") this.statuses.delete(code); }, () => undefined);
    return status;
  }

  private async read(code: string): Promise<CodePageStatus> {
    const { gate, repository } = this.deps;
    const held = await gate.codes().lookup(code);
    if (!held || !await gate.required(held.productId)) return { state: "entry", reason: "not_found" };
    if (held.status === "pending" || held.status === "void") return { state: "entry", reason: "not_paid" };
    const { resolved, map } = await this.resolved(held.productId);
    const product = { id: held.productId, name: resolved.corpus.product.name };
    const creator = { name: resolved.corpus.creator.name };
    const conversation = held.status === "used" ? await repository.findOwnedConversation({ ownerAccountId: codeOwner(code), creatorId: resolved.corpus.creator.id }, codeConversationId(code)) : undefined;
    if (!conversation) {
      // Active, or spent whose conversation never got made (the process died between): the intake is still the way forward.
      const spec = resolved.corpus.product.brief_spec as BriefSpec | undefined;
      return { state: "intake", product, creator, fields: (spec?.fields ?? []).filter((field) => field.type !== "access_code").map((field) => ({ ...field })) };
    }
    const website = briefAnswer(conversation.briefSnapshot, "website");
    const who = { product, creator, ...(website ? { website } : {}) };
    const report = await this.deps.reportUrl(conversation);
    if (report) return { state: "ready", ...who, report_url: report };
    if (held.outcome === "failed") return { state: "failed", ...who };
    const names = new Set(await this.deps.store.toolNames(conversation.id));
    const step = map ? map.steps.reduce((reached, entry, index) => entry.tools.some((tool) => names.has(tool)) ? index : reached, -1) : -1;
    const email = briefEmail(conversation.briefSnapshot);
    return { state: "generating", ...who, started_at: conversation.createdAt, ...(email ? { email } : {}), ...(map ? { steps: map.steps.map(({ id, label }) => ({ id, label })), step } : {}) };
  }

  /**
   * The intake of an active code: its answers become the Brief, the code is spent for the conversation, and the Run starts. Spending comes
   * first, before any model call; every step is keyed by the code, so a second submit (a double click, a retry) finds the same conversation
   * and replays the same Run.
   */
  async intake(rawCode: string, answers: Record<string, unknown>): Promise<CodePageStatus> {
    const code = normalizeCode(rawCode);
    const { gate, corpora, repository } = this.deps;
    const held = await gate.codes().lookup(code);
    if (!held || !await gate.required(held.productId)) throw new ChatError("access_code_not_found", "兑换码不存在", 404);
    const { resolved } = await this.resolved(held.productId);
    const spec = resolved.corpus.product.brief_spec as BriefSpec | undefined;
    if (!spec) throw new ChatError("brief_unavailable", "This Product has no Brief.", 409);
    const codeField = spec.fields.find((field) => field.type === "access_code");
    const given = spec.fields.filter((field) => field.type !== "access_code").map((field) => ({ field_id: field.id, value: typeof answers[field.id] === "string" ? answers[field.id] as string : "" }));
    let brief;
    try { brief = createBriefSnapshot(spec, [...given, ...codeField ? [{ field_id: codeField.id, value: code }] : []]); }
    catch (error) { throw error instanceof BriefValidationError ? new ChatError("invalid_brief", error.message, 400) : error; }
    const scope = { creatorId: resolved.corpus.creator.id, userId: codeOwner(code), productId: held.productId, corpusDigest: resolved.digest, explicit: true };
    const id = durableConversationId(scope, codeConversationId(code));
    await gate.admit(held.productId, id, brief);
    const { conversation } = await repository.createConversation({ ...conversationBinding(scope), id, publicId: codeConversationId(code), briefSnapshot: brief });
    await this.deps.start(conversation, codeIntakeKey(code));
    this.statuses.delete(code);
    return this.status(code);
  }
}
