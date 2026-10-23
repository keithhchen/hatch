import path from "node:path";
import { parseSkillMarkdown } from "../../../skills.js";
import { WorkbenchStore } from "../../../factoryAgents/store.js";
import { AgentDefinition, type ExpertProduct, type Skill } from "../domain.js";
import type { AgentDefinitionRepository } from "../ports.js";

const SYSTEM_PATH = "output/SYSTEM.md";
const SKILL_PATH = /^output\/skills\/([^/]+)\/SKILL\.md$/;
const REFERENCE_PATH = /^output\/skills\/([^/]+)\/references\/([^/]+)\.md$/;
const REFERENCE_KINDS = ["method", "style", "example", "few_shots"] as const;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

type ReadFile = (name: string) => Promise<string>;
type Reference = Skill["references"][number];

/** Runtime Skill/Reference ids are lowercase words joined by single hyphens; repair anything else. */
export function runtimeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
}

/** Rewrites the front matter `name:` so the Skill loads under its repaired id. */
function withSkillName(source: string, id: string): string {
  const front = /^---\s*\n([\s\S]*?)\n---/.exec(source);
  if (!front) return source;
  const body = /^name:.*$/m.test(front[1]!) ? front[1]!.replace(/^name:.*$/m, `name: ${id}`) : `name: ${id}\n${front[1]}`;
  return source.replace(front[1]!, body);
}

/** A reference file; `kind:` in front matter picks its kind, default method. */
export class ReferenceDocument {
  constructor(readonly id: string, readonly content: string) {}

  get kind(): Reference["kind"] {
    const front = /^---\s*\n([\s\S]*?)\n---/.exec(this.content)?.[1] ?? "";
    const declared = /^kind:\s*["']?([a-z_]+)["']?\s*$/m.exec(front)?.[1];
    return REFERENCE_KINDS.find((kind) => kind === declared) ?? "method";
  }

  toReference(): Reference {
    return { id: this.id, kind: this.kind, content: this.content };
  }
}

/**
 * Reads `output/skills/<folder>/SKILL.md` plus `references/*.md` into Skills.
 * Publishing is never blocked here: invalid names are repaired, a duplicate
 * left behind under an old name yields to the correctly named Skill, and a
 * Skill that still cannot be read is skipped (logged for us, not shown to Experts).
 */
export class SkillFolderReader {
  constructor(private readonly paths: readonly string[], private readonly read: ReadFile) {}

  async skills(): Promise<Skill[]> {
    const folders = this.paths.flatMap((name) => SKILL_PATH.exec(name)?.[1] ?? [])
      // Correctly named folders first, so they win over leftovers that repair to the same id.
      .sort((a, b) => Number(runtimeId(b) === b) - Number(runtimeId(a) === a) || a.localeCompare(b));
    const loaded = await Promise.all(folders.map((folder) => this.skill(folder).catch((error: unknown) => {
      console.warn(`[productLive] skipped Skill ${folder}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    })));
    const seen = new Set<string>();
    return loaded.filter((skill): skill is Skill => skill !== null && !seen.has(skill.id) && Boolean(seen.add(skill.id)))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private async skill(folder: string): Promise<Skill> {
    const source = await this.read(`output/skills/${folder}/SKILL.md`);
    const declared = /^name:\s*["']?(.+?)["']?\s*$/m.exec(/^---\s*\n([\s\S]*?)\n---/.exec(source)?.[1] ?? "")?.[1] ?? folder;
    const id = runtimeId(declared) || runtimeId(folder);
    const { manifest, instructions } = parseSkillMarkdown(withSkillName(source, id));
    return { id: manifest.name, title: manifest.name, when_to_use: manifest.description, instruction: instructions, references: await this.references(folder) };
  }

  private async references(folder: string): Promise<Reference[]> {
    const matches = this.paths
      .map((name) => REFERENCE_PATH.exec(name))
      .filter((match): match is RegExpExecArray => match?.[1] === folder)
      .sort((a, b) => a[0].localeCompare(b[0]));
    const documents = await Promise.all(matches.map(async ([name, , file]) => new ReferenceDocument(runtimeId(file!), await this.read(name))));
    const seen = new Set<string>();
    return documents
      .filter((document) => document.id && document.content.trim() && !seen.has(document.id) && Boolean(seen.add(document.id)))
      .map((document) => document.toReference());
  }
}

/** Adapter: the newest Agent Builder session with a non-empty SYSTEM.md. */
export class WorkbenchAgentDefinitionRepository implements AgentDefinitionRepository {
  constructor(private readonly agentChatsRoot: string) {}

  async latestFor(product: ExpertProduct): Promise<AgentDefinition | null> {
    if (!SAFE_ID.test(product.creatorId) || !SAFE_ID.test(product.productId)) return null;
    const store = new WorkbenchStore(path.join(this.agentChatsRoot, product.creatorId, product.productId), product);
    const builders = (await store.list()).filter((session) => session.role === "generation" && session.files.some((file) => file.path === SYSTEM_PATH));
    for (const session of builders) {
      const read: ReadFile = async (name) => (await store.read(session.id, name)).bytes.toString("utf8");
      const paths = session.files.map((file) => file.path);
      const definition = AgentDefinition.whenPresent(await read(SYSTEM_PATH), await new SkillFolderReader(paths, read).skills());
      if (definition) return definition;
    }
    return null;
  }
}
