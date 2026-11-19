import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { limited, type AccessGate } from "../accessGate.js";
import type { AgentCorpusResolverLike } from "../agentCorpus.js";
import { BriefValidationError, createBriefSnapshot, type BriefSpec } from "../brief.js";
import { ChatError } from "../chat/principal.js";
import { DELIVERABLE_FOLLOWUP_PREFIX, MAX_DELIVERABLE_FOLLOWUPS } from "../chat/deliverableFollowup.js";
import { conversationBinding, durableConversationId } from "../chat/sessionBinding.js";
import type { ConversationRecord, ConversationRepository } from "../conversationRepository.js";
import { log } from "../observability/log.js";
import type { RuntimeStore } from "../store.js";

/** What a person sees at /c/<code>: the entry, the intake form, the wait, the report, or a plain failure. */
export type CodePageState = "entry" | "intake" | "generating" | "ready" | "failed";
export type CodePageStatus = {
  state: CodePageState;
  /** Entry only: why the code did not open a page. */
  reason?: "not_found" | "not_paid" | "used_elsewhere";
  product?: { id: string; name: string };
  /** Intake only: what to ask. The access code is not asked: the page's own address is it. */
  fields?: Array<{ id: string; label: string; required: boolean; type?: string }>;
  /** Generating only: the steps the Product's own mapping names, and which one the Run has reached (-1: none yet). */
  steps?: Array<{ id: string; label: string }>;
  step?: number;
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
  store: Pick<RuntimeStore, "readRunActivity">;
  /** The signed link of the page the code's buyer published since the conversation began. */
  reportUrl(conversation: ConversationRecord): Promise<string | undefined>;
  /** Starts the Run of the Brief, under `key`: the same key again is the same Run. */
  start(conversation: ConversationRecord, key: string): Promise<unknown>;
};

/**
 * The page of an access code. The code is the buyer's only credential and it opens exactly one conversation, which the buyer never
 * sees: they submit the intake, wait, and receive the report. Everything here is by the code; a Product without the access code
 * capability is not found.
 */
export class CodePages {
  private readonly reported = new Set<string>();
  constructor(private readonly deps: CodePagesDeps) {}

  async status(rawCode: string, headers?: http.IncomingHttpHeaders): Promise<CodePageStatus> {
    const code = normalizeCode(rawCode);
    const { gate, corpora, repository } = this.deps;
    const held = await limited(gate.codes(headers).lookup(code));
    if (!held || !await gate.required(held.productId)) return { state: "entry", reason: "not_found" };
    if (held.status === "pending" || held.status === "void") return { state: "entry", reason: "not_paid" };
    const resolved = await corpora.resolveByProduct(held.productId);
    const product = { id: held.productId, name: resolved.corpus.product.name };
    const conversation = held.status === "used" ? await repository.findOwnedConversation({ ownerAccountId: codeOwner(code), creatorId: resolved.corpus.creator.id }, codeConversationId(code)) : undefined;
    if (!conversation) {
      // Active, or spent whose conversation never got made (the process died between): the intake is still the way forward.
      const spec = resolved.corpus.product.brief_spec as BriefSpec | undefined;
      return { state: "intake", product, fields: (spec?.fields ?? []).filter((field) => field.type !== "access_code").map((field) => ({ ...field })) };
    }
    const report = await this.deps.reportUrl(conversation);
    if (report) return { state: "ready", product, report_url: report };
    const runs = (await repository.listRuns(conversation.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const last = runs.at(-1);
    let followups = 0;
    for (let i = runs.length - 1; i >= 0 && runs[i]!.clientMessageId.startsWith(DELIVERABLE_FOLLOWUP_PREFIX); i--) followups++;
    const failed = last?.status === "failed" || last?.status === "cancelled" || (last?.status === "completed" && followups >= MAX_DELIVERABLE_FOLLOWUPS);
    if (failed) {
      if (!this.reported.has(code)) { this.reported.add(code); log.error("code_page_failed", { conversation_id: conversation.id, product_id: held.productId, last_run: last?.id, last_status: last?.status }); }
      return { state: "failed", product };
    }
    const map = await readProgressMap(resolved.root);
    const names = new Set<string>();
    for (const run of runs) for (const call of (await this.deps.store.readRunActivity(conversation.id, run.id)).tool_calls ?? []) names.add(call.name);
    const step = map ? map.steps.reduce((reached, entry, index) => entry.tools.some((tool) => names.has(tool)) ? index : reached, -1) : -1;
    return { state: "generating", product, ...(map ? { steps: map.steps.map(({ id, label }) => ({ id, label })), step } : {}) };
  }

  /**
   * The intake of an active code: its answers become the Brief, the code is spent for the conversation, and the Run starts. Spending comes
   * first, before any model call; every step is keyed by the code, so a second submit (a double click, a retry) finds the same conversation
   * and replays the same Run.
   */
  async intake(rawCode: string, answers: Record<string, unknown>, headers?: http.IncomingHttpHeaders): Promise<CodePageStatus> {
    const code = normalizeCode(rawCode);
    const { gate, corpora, repository } = this.deps;
    const held = await limited(gate.codes(headers).lookup(code));
    if (!held || !await gate.required(held.productId)) throw new ChatError("access_code_not_found", "兑换码不存在", 404);
    const resolved = await corpora.resolveByProduct(held.productId);
    const spec = resolved.corpus.product.brief_spec as BriefSpec | undefined;
    if (!spec) throw new ChatError("brief_unavailable", "This Product has no Brief.", 409);
    const codeField = spec.fields.find((field) => field.type === "access_code");
    const given = spec.fields.filter((field) => field.type !== "access_code").map((field) => ({ field_id: field.id, value: typeof answers[field.id] === "string" ? answers[field.id] as string : "" }));
    let brief;
    try { brief = createBriefSnapshot(spec, [...given, ...codeField ? [{ field_id: codeField.id, value: code }] : []]); }
    catch (error) { throw error instanceof BriefValidationError ? new ChatError("invalid_brief", error.message, 400) : error; }
    const scope = { creatorId: resolved.corpus.creator.id, userId: codeOwner(code), productId: held.productId, corpusDigest: resolved.digest, explicit: true };
    const id = durableConversationId(scope, codeConversationId(code));
    await gate.admit(held.productId, id, brief, headers);
    const { conversation } = await repository.createConversation({ ...conversationBinding(scope), id, publicId: codeConversationId(code), briefSnapshot: brief });
    await this.deps.start(conversation, codeIntakeKey(code));
    return this.status(code, headers);
  }
}
