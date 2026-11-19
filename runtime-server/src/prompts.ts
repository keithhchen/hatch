import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MODEL_ROLES, MODEL_ROLES_SCHEMA, type ModelRole } from "./modelRoles.js";
import type { PostgresQueryExecutor } from "./postgresStore.js";

/** The model-facing instructions the Runtime reads, keyed by the model role they are given to. The files in prompts/ are only each one's first value. */
export const PROMPT_FILES = { title: "conversation-title/TITLE.md" } as const satisfies Partial<Record<ModelRole, string>>;
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
 * A role's prompt is the `prompt` column of its `hatch_model_roles` row, read at each use: changing it is an UPDATE, no deploy,
 * like switching the role's model. The column is added and the row set from its file only while the prompt is null, so an edit is never overwritten.
 */
export class PostgresPrompts implements Prompts {
  private ready?: Promise<void>;
  constructor(private readonly db: PostgresQueryExecutor) {}

  private ensure(): Promise<void> {
    return this.ready ??= (async () => {
      await this.db.query(MODEL_ROLES_SCHEMA);
      for (const name of Object.keys(PROMPT_FILES) as PromptName[]) {
        await this.db.query("INSERT INTO hatch_model_roles (role, profile) VALUES ($1, $2) ON CONFLICT (role) DO NOTHING", [name, MODEL_ROLES[name]]);
        await this.db.query("UPDATE hatch_model_roles SET prompt = $2 WHERE role = $1 AND prompt IS NULL", [name, await read(name)]);
      }
    })().catch(error => { this.ready = undefined; throw error; });
  }

  async get(name: PromptName) {
    await this.ensure();
    const body = (await this.db.query<{ prompt: string | null }>("SELECT prompt FROM hatch_model_roles WHERE role = $1", [name])).rows[0]?.prompt;
    if (!body?.trim()) throw new Error(`hatch_model_roles has no prompt for role ${name}`);
    return body;
  }
}
