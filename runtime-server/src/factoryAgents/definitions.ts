import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { z } from "zod";
import { ROLES, type Role, type Session } from "./store.js";

const roleSchema = z.enum(ROLES);
const localizedSchema = z.object({ en: z.string().min(1).max(200), zh: z.string().min(1).max(200), ja: z.string().min(1).max(200) }).strict();
const toolSchema = z.enum(["update_todo", "list", "read", "write", "web_search", "web_scrape", "youtube_transcript", "corpus_upload", "hatch_tool"]);
const definitionSchema = z.object({
  role: roleSchema,
  order: z.number().int().nonnegative(),
  name: localizedSchema,
  hint: localizedSchema,
  systemPrompt: z.string().min(100),
  tools: z.array(toolSchema).min(1),
}).strict();
const definitionsSchema = z.array(definitionSchema).length(ROLES.length).superRefine((definitions, context) => {
  if (new Set(definitions.map(item => item.role)).size !== ROLES.length) context.addIssue({ code: "custom", message: "Every Factory Agent role must be defined exactly once" });
  if (new Set(definitions.map(item => item.order)).size !== definitions.length) context.addIssue({ code: "custom", message: "Factory Agent order values must be unique" });
  for (const definition of definitions) {
    if (new Set(definition.tools).size !== definition.tools.length) context.addIssue({ code: "custom", message: `${definition.role} tools must not repeat` });
  }
});

/**
 * Temporary capability cutover: no Factory Agent may receive YouTube
 * transcript access. Keep the shared implementation available for a future
 * re-enable, but enforce this at the persisted definition boundary as well as
 * at seed time.
 */
function disableYoutubeTranscriptAccess(definitions: AgentDefinition[]): AgentDefinition[] {
  return definitions.map(definition => {
    const systemPrompt = definition.systemPrompt.includes("youtube_transcript")
      ? `${definition.systemPrompt
          .split(/\r?\n/)
          .filter(line => !line.includes("youtube_transcript"))
          .join("\n")
          .trimEnd()}

# 临时能力限制
YouTube 视频字幕转录能力当前暂时不可用。不要尝试调用任何字幕转录工具；仅使用当前实际提供的其他工具。`
      : definition.systemPrompt;
    return { ...definition, tools: definition.tools.filter(tool => tool !== "youtube_transcript"), systemPrompt };
  });
}

export type AgentDefinition = z.infer<typeof definitionSchema>;
export type AgentEntryState = "locked" | "ready" | "running" | "complete" | "update_available" | "failed";
export type AgentEntry = Pick<AgentDefinition, "role" | "order" | "name" | "hint"> & { state: AgentEntryState; outputUpdatedAt?: string; sessionId?: string };
export interface AgentDefinitionRepository { list(): Promise<AgentDefinition[]> }
export class AgentDefinitionsError extends Error {
  readonly code = "agent_definitions_invalid";
  readonly status = 503;
  constructor(message: string, options?: ErrorOptions) { super(message, options); }
}
/** Build cannot start until the Expert has uploaded material or the interview has output. */
export class BuildNotReadyError extends Error {
  readonly code = "build_not_ready";
  readonly status = 409;
  constructor() { super("Upload material or do the interview before building."); }
}

export class PostgresAgentDefinitionRepository implements AgentDefinitionRepository {
  private constructor(private pool: Pool) {}
  static async open(pool: Pool): Promise<PostgresAgentDefinitionRepository> {
    const repository = new PostgresAgentDefinitionRepository(pool);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_factory_agent_definitions (
        role TEXT PRIMARY KEY,
        definition JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const count = Number((await pool.query("SELECT COUNT(*)::int AS count FROM hatch_factory_agent_definitions")).rows[0]?.count ?? 0);
    if (count === 0) await repository.bootstrap();
    else await repository.migrateTemporaryYoutubeTranscriptDisable();
    await repository.list();
    return repository;
  }
  async list(): Promise<AgentDefinition[]> {
    return disableYoutubeTranscriptAccess(await this.read());
  }
  private async read(): Promise<AgentDefinition[]> {
    const rows = (await this.pool.query("SELECT role, definition FROM hatch_factory_agent_definitions")).rows;
    return validateDefinitions(rows.map(row => {
      if (row.definition?.role !== row.role) throw new AgentDefinitionsError(`Factory Agent definition role mismatch: ${row.role}`);
      // Rows written before the dependency graph was retired still carry it; it is ignored here, not rewritten.
      const { dependencies: _retired, ...definition } = row.definition;
      return definition;
    }));
  }
  async replace(value: unknown): Promise<AgentDefinition[]> {
    const definitions = disableYoutubeTranscriptAccess(validateDefinitions(value));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM hatch_factory_agent_definitions");
      for (const definition of definitions) await client.query(
        "INSERT INTO hatch_factory_agent_definitions (role, definition, updated_at) VALUES ($1, $2::jsonb, NOW())",
        [definition.role, JSON.stringify(definition)]
      );
      await client.query("COMMIT");
      return definitions;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  private async bootstrap(): Promise<void> {
    const definitions = await initialAgentDefinitions();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const definition of definitions) await client.query(
        "INSERT INTO hatch_factory_agent_definitions (role, definition) VALUES ($1, $2::jsonb) ON CONFLICT (role) DO NOTHING",
        [definition.role, JSON.stringify(definition)]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  private async migrateTemporaryYoutubeTranscriptDisable(): Promise<void> {
    const current = await this.read();
    const disabled = disableYoutubeTranscriptAccess(current);
    if (JSON.stringify(current) !== JSON.stringify(disabled)) await this.replace(disabled);
  }
}

/** Explicit test dependency; product Runtime never constructs this repository. */
export class MemoryAgentDefinitionRepository implements AgentDefinitionRepository {
  constructor(private definitions: AgentDefinition[]) { this.definitions = disableYoutubeTranscriptAccess(validateDefinitions(definitions)); }
  async list(): Promise<AgentDefinition[]> { return structuredClone(this.definitions); }
  replace(definitions: AgentDefinition[]): void { this.definitions = disableYoutubeTranscriptAccess(validateDefinitions(definitions)); }
}

export async function initialAgentDefinitions(): Promise<AgentDefinition[]> {
  const promptRoot = new URL("../../prompts/factory-agents/", import.meta.url);
  const common = await readFile(fileURLToPath(new URL("COMMON.md", promptRoot)), "utf8");
  const askUserGuidance = await readFile(fileURLToPath(new URL("ASKUSER.md", promptRoot)), "utf8");
  const seed = [
    { role: "research", order: 1, name: { en: "Deep Research", zh: "深度研究", ja: "深掘り調査" }, hint: { en: "Find primary evidence and reconstruct the Expert as a whole person.", zh: "寻找一手证据，还原一个有血有肉的 Expert。", ja: "一次情報から、Expert という人物全体を立体的に捉えます。" }, tools: ["update_todo", "list", "read", "write", "web_search", "web_scrape"] },
    { role: "voice", order: 2, name: { en: "Voice Interview", zh: "语音访谈", ja: "音声インタビュー" }, hint: { en: "Draw out stories and tacit judgment in a natural conversation.", zh: "用自然对话挖出经历、故事和隐性判断。", ja: "自然な対話から経験、物語、暗黙の判断を引き出します。" }, tools: ["update_todo", "list", "read", "write", "web_search", "web_scrape"] },
    { role: "generation", order: 3, name: { en: "Agent Builder", zh: "Agent 构建", ja: "Agent 構築" }, hint: { en: "Turn the Expert's identity and judgment into an executable expert Agent.", zh: "把 Expert 的人格与判断变成可执行的专家 Agent。", ja: "Expert の人格と判断を、実行可能な専門 Agent に変えます。" }, tools: ["update_todo", "list", "read", "write", "corpus_upload"] },
    { role: "case-generation", order: 4, name: { en: "Case Builder", zh: "案例构建", ja: "ケース構築" }, hint: { en: "Build one realistic client situation that demands expert judgment.", zh: "构造一个真正需要专家判断的现实客户情境。", ja: "専門家の判断が本当に必要な顧客状況を構築します。" }, tools: ["update_todo", "list", "read", "write"] },
    { role: "evaluator", order: 5, name: { en: "Evaluator", zh: "效果评估", ja: "効果評価" }, hint: { en: "Find the few changes that matter most, then calibrate them with the Expert.", zh: "找出最影响客户结果的少数错位，再请 Expert 校准。", ja: "結果を大きく変える少数のずれを見つけ、Expert と校正します。" }, tools: ["update_todo", "list", "read", "write", "hatch_tool"] },
  ] as const;
  return validateDefinitions(await Promise.all(seed.map(async definition => ({
    ...definition,
    systemPrompt: `${await readFile(fileURLToPath(new URL(`${definition.role}/SYSTEM.md`, promptRoot)), "utf8")}\n\n${common}${definition.role === "voice" ? "" : `\n\n${askUserGuidance}`}`,
  }))));
}

export function validateDefinitions(value: unknown): AgentDefinition[] {
  const parsed = definitionsSchema.safeParse(value);
  if (!parsed.success) throw new AgentDefinitionsError("Factory Agent definitions are invalid.", { cause: parsed.error });
  return parsed.data.sort((a, b) => a.order - b.order);
}

function hasOutput(session: Session | undefined): boolean { return Boolean(session?.outputUpdatedAt); }

/** Build is available once there is uploaded material or interview output; an advanced Agent is always available. */
const unlockedFor = (role: Role, uploaded: boolean, byRole: Map<Role, Session>) => role !== "generation" || uploaded || hasOutput(byRole.get("voice"));

export function agentEntries(definitions: AgentDefinition[], sessions: Session[], manualFiles: readonly unknown[]): AgentEntry[] {
  const byRole = new Map(sessions.map(session => [session.role as Role, session]));
  return definitions.map(definition => {
    const session = byRole.get(definition.role);
    const voiceUpdatedAt = byRole.get("voice")?.outputUpdatedAt;
    const changed = definition.role === "generation" && Boolean(session?.outputUpdatedAt && voiceUpdatedAt && voiceUpdatedAt > session.outputUpdatedAt);
    let state: AgentEntryState;
    if (session?.status === "running") state = "running";
    else if (!unlockedFor(definition.role, manualFiles.length > 0, byRole)) state = "locked";
    else if (session?.status === "failed") state = "failed";
    else if (!hasOutput(session)) state = "ready";
    else state = changed ? "update_available" : "complete";
    return { role: definition.role, order: definition.order, name: definition.name, hint: definition.hint, state, ...(session ? { sessionId: session.id, outputUpdatedAt: session.outputUpdatedAt } : {}) };
  });
}

export function assertAgentAvailable(entries: AgentEntry[], role: Role): void {
  const entry = entries.find(candidate => candidate.role === role);
  if (!entry) throw new AgentDefinitionsError(`Factory Agent definition is missing: ${role}`);
  if (entry.state === "locked") throw new BuildNotReadyError();
}
