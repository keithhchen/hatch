import { randomUUID } from "node:crypto";
import type { ConversationRecord } from "../conversationRepository.js";
import type { ProductAnalytics } from "../analytics/port.js";
import { reportReady } from "../analytics/events.js";
import { scopeKey } from "../assets/domain.js";
import { assetScopeOf } from "../chat/assets.js";
import { validateReportHtml } from "./html.js";
import type { RenderedReport, ReportBlobs, ReportKeys, ReportPhase, ReportRenderer, ReportRepository } from "./ports.js";
import type { ReportProgress } from "./progress.js";

/** Rendering is a hosted agent's work and takes minutes, not seconds. */
export const RENDER_TIMEOUT_MS = 8 * 60_000;
/** A rendering that fails is tried again this many more times, after these pauses, before the agent is told. */
export const RENDER_RETRY_PAUSES_MS = [5_000, 15_000] as const;

const HTML = "text/html; charset=utf-8";
const PDF = Buffer.from("%PDF-");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const must = (name: string, bytes: Buffer, magic: Buffer) => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || !bytes.subarray(0, magic.length).equals(magic)) throw new Error(`The renderer produced an invalid ${name}`);
};
const validated = (phase: ReportPhase, r: RenderedReport) => {
  must(`${phase}.pdf`, r.pdf, PDF);
  if (phase === "summary") must("summary.png", r.firstPagePng, PNG);
  return r;
};

/**
 * publish_report: validate the HTML, render it (retrying a failed rendering), write the phase's files under a fresh prefix,
 * and only then switch the report row in one UPDATE: readers see the previous complete set or none. The summary must print
 * on exactly one page. A contract violation is answered as text for the agent to fix; a rendering that keeps failing is thrown,
 * so the agent sees a tool error.
 */
export class ReportPublisher {
  constructor(private readonly deps: {
    reports: ReportRepository; renderer: ReportRenderer; blobs: ReportBlobs; analytics?: ProductAnalytics;
    renderTimeoutMs?: number; pausesMs?: readonly number[]; sleep?: (ms: number) => Promise<void>; clock?: () => Date; id?: () => string;
  }) {}

  async publish(input: { conversation: Pick<ConversationRecord, "id" | "ownerAccountId">; phase: ReportPhase; attempt: number; html: unknown; startedAt: number; progress?: ReportProgress; signal?: AbortSignal }): Promise<string> {
    const { reports, renderer, blobs, analytics, renderTimeoutMs = RENDER_TIMEOUT_MS, pausesMs = RENDER_RETRY_PAUSES_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = () => new Date(), id = randomUUID } = this.deps;
    const { conversation } = input;
    if (typeof input.html !== "string") return "Not published: html must be the complete HTML document as a string.";
    const errors = validateReportHtml(input.html);
    if (errors.length) return `Not published. Fix these and call publish_report again:\n${errors.map((error) => `- ${error}`).join("\n")}`;
    await input.progress?.record("rendering");
    let rendered: RenderedReport | undefined;
    for (let attempt = 0; !rendered; attempt++) {
      const deadline = AbortSignal.timeout(renderTimeoutMs);
      try {
        rendered = validated(input.phase, await renderer.render(input.html, input.signal ? AbortSignal.any([input.signal, deadline]) : deadline));
      } catch (error) {
        input.signal?.throwIfAborted();
        if (attempt >= pausesMs.length) throw new Error(`Rendering the report failed: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(pausesMs[attempt]!);
      }
    }
    if (input.phase === "summary" && rendered.pages !== 1) return `Not published: the summary runs over one page (${rendered.pages} pages); shorten it and publish again.`;
    const prefix = `${scopeKey(assetScopeOf(conversation))}/report/${id()}`;
    const files: Array<[keyof ReportKeys, string, Buffer, string]> = input.phase === "summary"
      ? [["summaryHtml", "summary.html", Buffer.from(input.html), HTML], ["summaryPdf", "summary.pdf", rendered.pdf, "application/pdf"], ["summaryPng", "summary.png", rendered.firstPagePng, "image/png"]]
      : [["fullHtml", "full.html", Buffer.from(input.html), HTML], ["fullPdf", "full.pdf", rendered.pdf, "application/pdf"]];
    const keys: ReportKeys = Object.fromEntries(files.map(([key, name]) => [key, `${prefix}/${name}`]));
    await Promise.all(files.map(([, name, bytes, contentType]) => blobs.put(`${prefix}/${name}`, bytes, { contentType })));
    const record = await reports.ready(conversation.id, input.attempt, input.phase, keys, clock());
    if (!record) throw new Error("This report is now being produced by a newer attempt; stop.");
    analytics?.capture(conversation.ownerAccountId, reportReady(Math.round((Date.now() - input.startedAt) / 1000)));
    return "Report published.";
  }
}
