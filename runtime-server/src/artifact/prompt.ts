import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import type { ArtifactConfig, ReportPhase } from "./ports.js";

const read = (name: string) => readFile(fileURLToPath(new URL(`../../prompts/artifact/${name}`, import.meta.url)), "utf8");

const TOOLS = `# Report tools
- \`ls\` lists the client's files as /attachments/<name>, and /attachments/<name>.md for each file that has a text form.
- \`read(path, offset?, page?)\`: a .md path returns its text in pages. An original image is shown to you. An original PDF shows page \`page\` (default 1) as an image, with "page N of M". Any other original (docx, xlsx...) is read through its .md.
- \`grep\` searches the .md texts.
- \`web_search(query, objective)\` searches the public web, for facts that change over time.
- \`write(path, content)\` and \`edit(path, old_string, new_string)\` create and change your files under /report/; \`read\` and \`ls\` reach them too. /report/ sits beside /attachments/ like any directory.
- \`publish_report(path)\` publishes the report file once; it returns "Report published." or the exact errors to fix in the file.`;

const PHASE_FILES = { summary: "SUMMARY.md", full: "FULL.md" } as const;

/** What each phase's Run is told to deliver. The database decides; the files in prompts/artifact are only its first rows. */
export interface PhasePrompts {
  get(phase: ReportPhase): Promise<string>;
}

/** Tests and a Runtime without a database: the files themselves. */
export class FilePhasePrompts implements PhasePrompts {
  get(phase: ReportPhase) { return read(PHASE_FILES[phase]); }
}

/**
 * The phase prompts in `hatch_artifact_phase_prompts`, read at the start of each Run: changing one is an UPDATE, no deploy.
 * A row is inserted from its file only when the phase has none, so an edited row is never overwritten.
 */
export class PostgresPhasePrompts implements PhasePrompts {
  constructor(private readonly db: PostgresQueryExecutor) {}
  async initialize() {
    await this.db.query(`CREATE TABLE IF NOT EXISTS hatch_artifact_phase_prompts (
      phase TEXT PRIMARY KEY CHECK (phase IN ('summary', 'full')),
      body TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    for (const phase of Object.keys(PHASE_FILES) as ReportPhase[]) {
      await this.db.query("INSERT INTO hatch_artifact_phase_prompts (phase, body) VALUES ($1, $2) ON CONFLICT (phase) DO NOTHING", [phase, await read(PHASE_FILES[phase])]);
    }
  }
  async get(phase: ReportPhase) {
    const body = (await this.db.query<{ body: string }>("SELECT body FROM hatch_artifact_phase_prompts WHERE phase = $1", [phase])).rows[0]?.body;
    if (!body?.trim()) throw new Error(`hatch_artifact_phase_prompts has no prompt for the ${phase} phase`);
    return body;
  }
}

/** What an artifact conversation's agent is told beyond the Expert's own instructions: the shared report rules, the product's template, the tools, and what this phase's Run delivers. */
export async function artifactPrompt(config: ArtifactConfig, phase: ReportPhase, prompts: PhasePrompts): Promise<string> {
  return [await read("REPORT.md"), `# This product's report template\n\n${config.reportTemplate}`, TOOLS, await prompts.get(phase)].join("\n\n");
}

/** What a new attempt is told: the form is already in the conversation, and so is whatever the earlier attempt did. */
export const ARTIFACT_RETRY_MESSAGE = "Continue. The report is not published yet. Your files under /report/ are as you left them: check them with ls /report/, carry on from where you stopped, proofread, and call publish_report.";


/** What the Run of the full phase is told: the parent has unlocked the report. */
export const ARTIFACT_FULL_MESSAGE = "The parent has unlocked the full report. Write it now, as your instructions for this Run describe.";
