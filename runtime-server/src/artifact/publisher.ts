import { randomUUID } from "node:crypto";
import type { ConversationRecord } from "../conversationRepository.js";
import type { ProductAnalytics } from "../analytics/port.js";
import { reportReady } from "../analytics/events.js";
import { scopeKey, type AssetBlobs } from "../assets/domain.js";
import { assetScopeOf } from "../chat/assets.js";
import { deriveFreeHtml } from "./html.js";
import type { RenderedReport, ReportKeys, ReportRenderer, ReportRepository } from "./ports.js";
import type { ReportProgress } from "./progress.js";

/** Rendering is a hosted agent's work and takes minutes, not seconds. */
export const RENDER_TIMEOUT_MS = 8 * 60_000;
/** A rendering that fails is tried again this many more times, after these pauses, before the agent is told. */
export const RENDER_RETRY_PAUSES_MS = [5_000, 15_000] as const;

const PDF = Buffer.from("%PDF-");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const must = (name: string, bytes: Buffer, magic: Buffer) => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || !bytes.subarray(0, magic.length).equals(magic)) throw new Error(`The renderer produced an invalid ${name}`);
};
const validated = (r: RenderedReport) => { must("full.pdf", r.fullPdf, PDF); must("free.pdf", r.freePdf, PDF); must("preview.png", r.preview, PNG); return r; };

/**
 * publish_report: validate the HTML, derive the free HTML, render (retrying a failed rendering), write the five files under a
 * fresh prefix, and only then switch the report row in one UPDATE: readers see the previous complete set or none. A contract
 * violation is answered as text for the agent to fix; a rendering that keeps failing is thrown, so the agent sees a tool error.
 */
export class ReportPublisher {
  constructor(private readonly deps: {
    reports: ReportRepository; renderer: ReportRenderer; blobs: AssetBlobs; analytics?: ProductAnalytics;
    renderTimeoutMs?: number; pausesMs?: readonly number[]; sleep?: (ms: number) => Promise<void>; clock?: () => Date; id?: () => string;
  }) {}

  async publish(input: { conversation: Pick<ConversationRecord, "id" | "ownerAccountId">; attempt: number; html: unknown; startedAt: number; progress?: ReportProgress; signal?: AbortSignal }): Promise<string> {
    const { reports, renderer, blobs, analytics, renderTimeoutMs = RENDER_TIMEOUT_MS, pausesMs = RENDER_RETRY_PAUSES_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = () => new Date(), id = randomUUID } = this.deps;
    const { conversation } = input;
    if (typeof input.html !== "string") return "Not published: html must be the complete HTML document as a string.";
    const derived = deriveFreeHtml(input.html);
    if (!derived.ok) return `Not published. Fix these and call publish_report again:\n${derived.errors.map((error) => `- ${error}`).join("\n")}`;
    await input.progress?.record("rendering");
    let rendered: RenderedReport | undefined;
    for (let attempt = 0; !rendered; attempt++) {
      const deadline = AbortSignal.timeout(renderTimeoutMs);
      try {
        rendered = validated(await renderer.render({ fullHtml: input.html, freeHtml: derived.freeHtml }, input.signal ? AbortSignal.any([input.signal, deadline]) : deadline));
      } catch (error) {
        input.signal?.throwIfAborted();
        if (attempt >= pausesMs.length) throw new Error(`Rendering the report failed: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(pausesMs[attempt]!);
      }
    }
    const prefix = `${scopeKey(assetScopeOf(conversation))}/report/${id()}`;
    const keys: ReportKeys = { fullHtml: `${prefix}/full.html`, freeHtml: `${prefix}/free.html`, fullPdf: `${prefix}/full.pdf`, freePdf: `${prefix}/free.pdf`, preview: `${prefix}/preview.png` };
    await Promise.all([
      blobs.put(keys.fullHtml, Buffer.from(input.html), { contentType: "text/html; charset=utf-8" }),
      blobs.put(keys.freeHtml, Buffer.from(derived.freeHtml), { contentType: "text/html; charset=utf-8" }),
      blobs.put(keys.fullPdf, rendered.fullPdf, { contentType: "application/pdf" }),
      blobs.put(keys.freePdf, rendered.freePdf, { contentType: "application/pdf" }),
      blobs.put(keys.preview, rendered.preview, { contentType: "image/png" })
    ]);
    const record = await reports.ready(conversation.id, input.attempt, keys, clock());
    if (!record) throw new Error("This report is now being produced by a newer attempt; stop.");
    analytics?.capture(conversation.ownerAccountId, reportReady(Math.round((Date.now() - input.startedAt) / 1000)));
    return "Report published.";
  }
}
