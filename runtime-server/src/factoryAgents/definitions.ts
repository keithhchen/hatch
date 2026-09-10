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
  dependencies: z.object({ required: z.array(roleSchema), normal: z.array(roleSchema) }).strict(),
}).strict();
const definitionsSchema = z.array(definitionSchema).length(ROLES.length).superRefine((definitions, context) => {
  if (new Set(definitions.map(item => item.role)).size !== ROLES.length) context.addIssue({ code: "custom", message: "Every Factory Agent role must be defined exactly once" });
  if (new Set(definitions.map(item => item.order)).size !== definitions.length) context.addIssue({ code: "custom", message: "Factory Agent order values must be unique" });
  for (const definition of definitions) {
    const dependencies = [...definition.dependencies.required, ...definition.dependencies.normal];
    if (dependencies.includes(definition.role)) context.addIssue({ code: "custom", message: `${definition.role} cannot depend on itself` });
    if (new Set(dependencies).size !== dependencies.length) context.addIssue({ code: "custom", message: `${definition.role} dependencies must not repeat` });
    if (new Set(definition.tools).size !== definition.tools.length) context.addIssue({ code: "custom", message: `${definition.role} tools must not repeat` });
  }
  const reachable = new Set<Role>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of definitions) {
      if (reachable.has(definition.role)) continue;
      const requiredReady = definition.dependencies.required.every(role => reachable.has(role));
      const normalReady = definition.dependencies.normal.length === 0 || definition.dependencies.normal.some(role => reachable.has(role));
      if (requiredReady && normalReady) { reachable.add(definition.role); changed = true; }
    }
  }
  if (reachable.size !== ROLES.length) context.addIssue({ code: "custom", message: `Factory Agent dependencies leave unreachable roles: ${ROLES.filter(role => !reachable.has(role)).join(", ")}` });
});

export type AgentDefinition = z.infer<typeof definitionSchema>;
export type AgentEntryState = "locked" | "ready" | "running" | "complete" | "update_available" | "failed";
export type AgentAvailability = { missingRequired: Role[]; normal: { required: boolean; satisfied: boolean }; updatedDependencies: Role[] };
export type AgentEntry = Pick<AgentDefinition, "role" | "order" | "name" | "hint" | "dependencies"> & { state: AgentEntryState; availability: AgentAvailability; sessionId?: string };
export interface AgentDefinitionRepository { list(): Promise<AgentDefinition[]> }
export class AgentDefinitionsError extends Error {
  readonly code = "agent_definitions_invalid";
  readonly status = 503;
  constructor(message: string, options?: ErrorOptions) { super(message, options); }
}
export class AgentDependenciesNotReadyError extends Error {
  readonly code = "agent_dependencies_not_ready";
  readonly status = 409;
  readonly details: { role: Role; missingRequired: Role[]; normalCandidates: Role[]; normalSatisfied: boolean };
  constructor(entry: AgentEntry) {
    super("This Agent's dependencies are not ready.");
    this.details = { role: entry.role, missingRequired: entry.availability.missingRequired, normalCandidates: entry.dependencies.normal, normalSatisfied: entry.availability.normal.satisfied };
  }
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
    else await repository.migrateLegacyDependencyGraph();
    await repository.list();
    return repository;
  }
  async list(): Promise<AgentDefinition[]> {
    const rows = (await this.pool.query("SELECT role, definition FROM hatch_factory_agent_definitions")).rows;
    return validateDefinitions(rows.map(row => {
      if (row.definition?.role !== row.role) throw new AgentDefinitionsError(`Factory Agent definition role mismatch: ${row.role}`);
      return row.definition;
    }));
  }
  async replace(value: unknown): Promise<AgentDefinition[]> {
    const definitions = validateDefinitions(value);
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
  private async migrateLegacyDependencyGraph(): Promise<void> {
    const definitions = await this.list();
    const legacy: Record<Role, { required: Role[]; normal: Role[] }> = {
      research: { required: [], normal: [] },
      voice: { required: ["research"], normal: [] },
      generation: { required: ["research"], normal: ["voice", "evaluator"] },
      "case-generation": { required: ["generation"], normal: [] },
      evaluator: { required: ["generation", "case-generation"], normal: [] },
    };
    const matchesLegacy = definitions.every(definition => JSON.stringify(definition.dependencies) === JSON.stringify(legacy[definition.role]));
    if (!matchesLegacy) return;
    const next = definitions.map(definition => ({
      ...definition,
      dependencies: definition.role === "generation"
        ? { required: [] as Role[], normal: ["research", "voice"] as Role[] }
        : definition.role === "voice"
          ? { required: [] as Role[], normal: [] as Role[] }
          : definition.dependencies,
    }));
    await this.replace(next);
  }
}

/** Explicit test dependency; product Runtime never constructs this repository. */
export class MemoryAgentDefinitionRepository implements AgentDefinitionRepository {
  constructor(private definitions: AgentDefinition[]) { this.definitions = validateDefinitions(definitions); }
  async list(): Promise<AgentDefinition[]> { return structuredClone(this.definitions); }
  replace(definitions: AgentDefinition[]): void { this.definitions = validateDefinitions(definitions); }
}

export async function initialAgentDefinitions(): Promise<AgentDefinition[]> {
  const promptRoot = new URL("../../prompts/factory-agents/", import.meta.url);
  const common = await readFile(fileURLToPath(new URL("COMMON.md", promptRoot)), "utf8");
  const seed = [
    { role: "research", order: 1, name: { en: "Deep Research", zh: "深度研究", ja: "深掘り調査" }, hint: { en: "Find primary evidence and reconstruct the Creator as a whole person.", zh: "寻找一手证据，还原一个有血有肉的 Creator。", ja: "一次情報から、Creator という人物全体を立体的に捉えます。" }, tools: ["update_todo", "list", "read", "write", "web_search", "web_scrape", "youtube_transcript"], dependencies: { required: [], normal: [] } },
    { role: "voice", order: 2, name: { en: "Voice Interview", zh: "语音访谈", ja: "音声インタビュー" }, hint: { en: "Draw out stories and tacit judgment in a natural conversation.", zh: "用自然对话挖出经历、故事和隐性判断。", ja: "自然な対話から経験、物語、暗黙の判断を引き出します。" }, tools: ["update_todo", "list", "read", "write", "web_search", "web_scrape", "youtube_transcript"], dependencies: { required: [], normal: [] } },
    { role: "generation", order: 3, name: { en: "Agent Builder", zh: "Agent 构建", ja: "Agent 構築" }, hint: { en: "Turn the Creator's identity and judgment into an executable expert Agent.", zh: "把 Creator 的人格与判断变成可执行的专家 Agent。", ja: "Creator の人格と判断を、実行可能な専門 Agent に変えます。" }, tools: ["update_todo", "list", "read", "write", "corpus_upload"], dependencies: { required: [], normal: ["research", "voice"] } },
    { role: "case-generation", order: 4, name: { en: "Case Builder", zh: "案例构建", ja: "ケース構築" }, hint: { en: "Build one realistic client situation that demands expert judgment.", zh: "构造一个真正需要专家判断的现实客户情境。", ja: "専門家の判断が本当に必要な顧客状況を構築します。" }, tools: ["update_todo", "list", "read", "write"], dependencies: { required: ["generation"], normal: [] } },
    { role: "evaluator", order: 5, name: { en: "Evaluator", zh: "效果评估", ja: "効果評価" }, hint: { en: "Run this Product and judge what its result truly gets right and wrong.", zh: "运行当前 Product，判断结果真正做对和做错了什么。", ja: "現在の Product を実行し、結果の本質的な良し悪しを評価します。" }, tools: ["update_todo", "list", "read", "write", "hatch_tool"], dependencies: { required: ["generation", "case-generation"], normal: [] } },
  ] as const;
  return validateDefinitions(await Promise.all(seed.map(async definition => ({ ...definition, systemPrompt: `${await readFile(fileURLToPath(new URL(`${definition.role}/SYSTEM.md`, promptRoot)), "utf8")}\n\n${common}` }))));
}

export function validateDefinitions(value: unknown): AgentDefinition[] {
  const parsed = definitionsSchema.safeParse(value);
  if (!parsed.success) throw new AgentDefinitionsError("Factory Agent definitions are invalid.", { cause: parsed.error });
  return parsed.data.sort((a, b) => a.order - b.order);
}

function hasOutput(session: Session | undefined): boolean { return Boolean(session?.outputUpdatedAt); }

export function agentEntries(definitions: AgentDefinition[], sessions: Session[]): AgentEntry[] {
  const byRole = new Map(sessions.map(session => [session.role, session]));
  return definitions.map(definition => {
    const session = byRole.get(definition.role);
    const missingRequired = definition.dependencies.required.filter(dependency => !hasOutput(byRole.get(dependency)));
    const normalRequired = definition.dependencies.normal.length > 0;
    const normalSatisfied = !normalRequired || definition.dependencies.normal.some(dependency => hasOutput(byRole.get(dependency)));
    const dependencies = [...definition.dependencies.required, ...definition.dependencies.normal];
    const updatedDependencies = session?.lastRunAt ? dependencies.filter(dependency => {
      const updatedAt = byRole.get(dependency)?.outputUpdatedAt;
      return Boolean(updatedAt && updatedAt > session.lastRunAt!);
    }) : [];
    const availability = { missingRequired, normal: { required: normalRequired, satisfied: normalSatisfied }, updatedDependencies };
    const unlocked = missingRequired.length === 0 && normalSatisfied;
    let state: AgentEntryState;
    if (session?.status === "running") state = "running";
    else if (!unlocked) state = "locked";
    else if (session?.status === "failed") state = "failed";
    else if (!hasOutput(session)) state = "ready";
    else {
      state = updatedDependencies.length ? "update_available" : "complete";
    }
    return { role: definition.role, order: definition.order, name: definition.name, hint: definition.hint, dependencies: definition.dependencies, state, availability, ...(session ? { sessionId: session.id } : {}) };
  });
}

export function assertAgentAvailable(entries: AgentEntry[], role: Role): void {
  const entry = entries.find(candidate => candidate.role === role);
  if (!entry) throw new AgentDefinitionsError(`Factory Agent definition is missing: ${role}`);
  if (entry.state === "locked") throw new AgentDependenciesNotReadyError(entry);
}
