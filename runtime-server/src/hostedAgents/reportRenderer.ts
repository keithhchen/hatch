import path from "node:path";
import { fileURLToPath } from "node:url";
import { KimiApi } from "./kimiApi.js";
import { KimiHostedAgent, TracedHostedAgent } from "./kimiHostedAgent.js";
import type { AgentSpec, HostedAgentProvider, SandboxSpec } from "./ports.js";
import { Provisioner } from "./provisioner.js";
import { zipDirectory } from "./zip.js";

// Mirrors runtime-server/src/artifact/ports.ts; replace with an import when that file lands.
export type RenderedReport = { fullPdf: Buffer; freePdf: Buffer; preview: Buffer };
export interface ReportRenderer { render(input: { fullHtml: string; freeHtml: string }, signal?: AbortSignal): Promise<RenderedReport>; }

export const RENDER_NOT_CONFIGURED = "Report rendering is not configured";

/** Chromium and CJK fonts preinstalled. The build needs the network (a limited sandbox cannot run the install); render.py blocks every non-file request in the browser. */
export const RENDER_SANDBOX: SandboxSpec = {
  name: "hatch-render",
  packages: { apt: ["fonts-noto-cjk", "fonts-noto-cjk-extra"], pip: ["playwright", "pypdf"] },
  setupScript: "python3 -m playwright install --with-deps chromium",
  networking: { type: "unrestricted" },
};

const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../hosted-skills");

export const renderAgent = (model: string): AgentSpec => ({
  name: "hatch-render",
  model,
  system: [
    "You turn two uploaded HTML files into PDFs and a preview image by running one fixed script of the hatch-render skill.",
    "Run it exactly as the skill says, then save full.pdf, free.pdf, preview.png and result.json with save_artifact.",
    "Never read, edit or summarize the HTML. Never create or alter output files yourself. If the script fails, report its error and stop.",
  ].join("\n"),
  skills: [{ name: "hatch-render", dir: path.join(SKILLS_ROOT, "hatch-render") }],
});

const PROMPT = "Use the hatch-render skill. full.html and free.html are uploaded. Run its script, save full.pdf, free.pdf, preview.png and result.json with save_artifact, then reply with one sentence.";

const MIN_BYTES = 1000;
const PDF_MAGIC = Buffer.from("%PDF-");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const valid = (name: string, bytes: Buffer, magic: Buffer) => {
  if (bytes.length < MIN_BYTES || !bytes.subarray(0, magic.length).equals(magic)) throw new Error(`The hosted renderer produced an invalid ${name}`);
  return bytes;
};

/** Renders report HTML on a hosted agent: files in, three validated artifacts out. */
export class HostedReportRenderer implements ReportRenderer {
  constructor(private readonly agent: HostedAgentProvider) {}

  async render(input: { fullHtml: string; freeHtml: string }, signal?: AbortSignal): Promise<RenderedReport> {
    const run = await this.agent.run({
      title: "render report",
      prompt: PROMPT,
      secrets: [],
      files: [
        { name: "full.html", bytes: Buffer.from(input.fullHtml), mimeType: "text/html" },
        { name: "free.html", bytes: Buffer.from(input.freeHtml), mimeType: "text/html" },
      ],
    }, signal);
    const get = (name: string) => {
      const found = run.artifacts.find(a => a.name === name)?.bytes;
      if (!found) throw new Error(`The hosted renderer did not produce ${name}${run.error ? `: ${run.error}` : ""}`);
      return found;
    };
    return {
      fullPdf: valid("full.pdf", get("full.pdf"), PDF_MAGIC),
      freePdf: valid("free.pdf", get("free.pdf"), PDF_MAGIC),
      preview: valid("preview.png", get("preview.png"), PNG_MAGIC),
    };
  }
}

/** Without a Kimi key there is no renderer: say so, never fake a result. */
class UnavailableRenderer implements ReportRenderer {
  async render(): Promise<never> { throw new Error(RENDER_NOT_CONFIGURED); }
}

/** The hosted renderer when the same key as hosted ingest is set; otherwise one that fails with a clear reason. */
export const createHostedReportRenderer = (environment: NodeJS.ProcessEnv, model = "kimi-k3.1-pro"): ReportRenderer => {
  const apiKey = environment.HATCH_MANAGED_AGENTS_API_KEY?.trim();
  if (!apiKey) return new UnavailableRenderer();
  const api = new KimiApi({ apiKey });
  const modelOf = async () => model;
  const provisioner = new Provisioner(api, RENDER_SANDBOX, async () => renderAgent(model), zipDirectory);
  return new HostedReportRenderer(new TracedHostedAgent(new KimiHostedAgent(api, provisioner), "kimi_hosted_agents", modelOf));
};
