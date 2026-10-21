import path from "node:path";
import { parseSkillMarkdown } from "../../../skills.js";
import { WorkbenchStore } from "../../../factoryAgents/store.js";
import { AgentDefinition, type ExpertProduct, type Skill } from "../domain.js";
import type { AgentDefinitionRepository } from "../ports.js";

const SYSTEM_PATH = "output/SYSTEM.md";
const SKILL_PATH = /^output\/skills\/([^/]+)\/SKILL\.md$/;
const REFERENCE_PATH = /^output\/skills\/([^/]+)\/references\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const REFERENCE_KINDS = ["method", "style", "example", "few_shots"] as const;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

type ReadFile = (name: string) => Promise<string>;
type Reference = Skill["references"][number];

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

/** Reads `output/skills/<folder>/SKILL.md` plus `references/*.md` into Skills. */
export class SkillFolderReader {
  constructor(private readonly paths: readonly string[], private readonly read: ReadFile) {}

  /** Readable Skills, plus "<folder>: <reason>" for each Skill file that fails validation. */
  async load(): Promise<{ skills: Skill[]; invalid: string[] }> {
    const folders = this.paths.flatMap((name) => SKILL_PATH.exec(name)?.[1] ?? []).sort();
    const results = await Promise.all(folders.map((folder) => this.skill(folder).then(
      (skill) => ({ skill }),
      (error: unknown) => ({ invalid: `${folder}: ${error instanceof Error ? error.message : String(error)}` }),
    )));
    return {
      skills: results.flatMap((result) => "skill" in result ? [result.skill] : []),
      invalid: results.flatMap((result) => "invalid" in result ? [result.invalid] : []),
    };
  }

  async skills(): Promise<Skill[]> {
    return (await this.load()).skills;
  }

  private async skill(folder: string): Promise<Skill> {
    const { manifest, instructions } = parseSkillMarkdown(await this.read(`output/skills/${folder}/SKILL.md`));
    return { id: manifest.name, title: manifest.name, when_to_use: manifest.description, instruction: instructions, references: await this.references(folder) };
  }

  private async references(folder: string): Promise<Reference[]> {
    const matches = this.paths
      .map((name) => REFERENCE_PATH.exec(name))
      .filter((match): match is RegExpExecArray => match?.[1] === folder)
      .sort((a, b) => a[0].localeCompare(b[0]));
    const documents = await Promise.all(matches.map(async ([name, , id]) => new ReferenceDocument(id!, await this.read(name))));
    return documents.filter((document) => document.content.trim()).map((document) => document.toReference());
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
      const { skills, invalid } = await new SkillFolderReader(paths, read).load();
      const definition = AgentDefinition.whenPresent(await read(SYSTEM_PATH), skills, invalid);
      if (definition) return definition;
    }
    return null;
  }
}
