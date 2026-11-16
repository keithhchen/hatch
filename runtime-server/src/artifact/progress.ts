import { log } from "../observability/log.js";
import type { ReportRepository, ReportStage } from "./ports.js";

/** The stage a tool call is, and the short safe detail shown with it: the tool and a file name, never contents or queries. */
export function stageOf(name: string, args: Record<string, unknown>): { stage: ReportStage; detail: string } | undefined {
  const path = typeof args.path === "string" ? ` ${args.path.slice(0, 80)}` : "";
  if (name.startsWith("attachments.") && path.startsWith(" /report/")) return { stage: "proofreading", detail: `${name.slice("attachments.".length)}${path}` };
  if (name.startsWith("attachments.")) return { stage: "reading", detail: `${name.slice("attachments.".length)}${path}` };
  if (name.startsWith("creator.")) return { stage: "consulting", detail: name };
  if (name === "web.search" || name === "hatch.web_search" || name === "artifact.web_search") return { stage: "researching", detail: "web_search" };
  if (name === "artifact.write" || name === "artifact.edit") return { stage: "writing", detail: `${name.slice("artifact.".length)}${path}` };
  if (name === "artifact.publish_report") return { stage: "rendering", detail: "publish_report" };
  return undefined;
}

/** The progress of one attempt of one report, written from that Run's own tool calls. A write that fails never fails the Run. */
export class ReportProgress {
  constructor(private readonly reports: ReportRepository, private readonly target: { conversationId: string; attempt: number }, private readonly clock: () => Date = () => new Date()) {}

  record(stage: ReportStage, detail?: string): Promise<void> {
    return this.reports.progress(this.target.conversationId, this.target.attempt, stage, detail, this.clock())
      .catch((error) => log.error("artifact_progress_failed", { conversationId: this.target.conversationId, error }));
  }

  onTool = (name: string, args: Record<string, unknown>): void => {
    const step = stageOf(name, args);
    if (step) void this.record(step.stage, step.detail);
  };
}
