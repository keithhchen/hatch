import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PostgresQueryExecutor } from "./postgresStore.js";

/** The platform's own model-facing instructions, by name. The files in prompts/ are only each one's first row. */
export const PROMPT_FILES = {
  "conversation-title": "conversation-title/TITLE.md",
  /** The report email every Product without its own template sends: the HTML and its subject line, with {{placeholders}}. */
  "report-email-default": "report-email/REPORT.html",
  "report-email-default-subject": "report-email/SUBJECT.txt"
} as const;
export type PromptName = keyof typeof PROMPT_FILES;

export interface Prompts {
  get(name: PromptName): Promise<string>;
}

const read = (name: PromptName) => readFile(fileURLToPath(new URL(`../prompts/${PROMPT_FILES[name]}`, import.meta.url)), "utf8");

/** Tests and a Runtime without a database: the files themselves. */
export class FilePrompts implements Prompts {
  get(name: PromptName) { return read(name); }
}

/**
 * The prompts in `hatch_prompts`, read at each use: changing one is an UPDATE, no deploy. The table is made on first use and a
 * row is inserted from its file only when its name has none, so an edited row is never overwritten.
 */
export class PostgresPrompts implements Prompts {
  private ready?: Promise<void>;
  constructor(private readonly db: PostgresQueryExecutor) {}

  private ensure(): Promise<void> {
    return this.ready ??= (async () => {
      await this.db.query(`CREATE TABLE IF NOT EXISTS hatch_prompts (
        name TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      for (const name of Object.keys(PROMPT_FILES) as PromptName[]) {
        await this.db.query("INSERT INTO hatch_prompts (name, body) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING", [name, await read(name)]);
      }
    })().catch(error => { this.ready = undefined; throw error; });
  }

  async get(name: PromptName) {
    await this.ensure();
    const body = (await this.db.query<{ body: string }>("SELECT body FROM hatch_prompts WHERE name = $1", [name])).rows[0]?.body;
    if (!body?.trim()) throw new Error(`hatch_prompts has no prompt named ${name}`);
    return body;
  }
}
