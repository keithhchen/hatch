import { access, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export type SkillScope = "repo" | "user" | "system" | "admin" | "custom";

export type SkillManifest = {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata: Record<string, string>;
  allowedTools?: string;
};

export type SkillPolicy = {
  allowImplicitInvocation: boolean;
  products: string[];
};

export type SkillInterface = {
  displayName?: string;
  shortDescription?: string;
  iconSmall?: string;
  iconLarge?: string;
  brandColor?: string;
  defaultPrompt?: string;
};

export type SkillToolDependency = {
  type: string;
  value: string;
  description?: string;
  transport?: string;
  command?: string;
  url?: string;
};

export type SkillOpenAIMetadata = {
  interface?: SkillInterface;
  policy: SkillPolicy;
  dependencies: {
    tools: SkillToolDependency[];
  };
};

export type SkillRecord = {
  id: string;
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  directory: string;
  root: string;
  scope: SkillScope;
  manifest: SkillManifest;
  openai: SkillOpenAIMetadata;
  enabled: boolean;
  diagnostics: string[];
};

export type Skill = SkillRecord & {
  instructions: string;
};

export type SkillCatalogEntry = {
  id: string;
  name: string;
  description: string;
  path: string;
};

export type SkillBundleResourceManifest = {
  paths: string[];
  truncated: boolean;
};

export type ImplicitSkillInvocation = {
  skill: SkillRecord;
  reason: "script_run" | "skill_doc_read";
  path: string;
};

export type SkillDiscoveryOptions = {
  prompt?: string;
  roots?: Array<{
    path: string;
    scope?: SkillScope;
    followSymlinks?: boolean;
  }>;
};

export type SkillsRenderReport = {
  total_count: number;
  included_count: number;
  omitted_count: number;
  truncated_description_chars: number;
  truncated_description_count: number;
  warning_message?: string;
};

export type SkillsRenderResult = {
  section: string;
  report: SkillsRenderReport;
  aliases: Record<string, string>;
};

type SkillRoot = {
  path: string;
  scope: SkillScope;
  followSymlinks: boolean;
  pluginNamespace?: string;
};

type ParsedSkillMarkdown = {
  manifest: SkillManifest;
  instructions: string;
  shortDescription?: string;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultSkillsRoot = path.resolve(here, "..", "skills");
const maxScanDepth = 6;
const maxSkillDirsPerRoot = 2000;
const maxSkillResourceManifestFiles = 200;
const fallbackSkillMetadataCharBudget = 8000;
const skillMetadataContextWindowFraction = 0.02;
const maxDescriptionChars = 1024;
const skillDescriptionTruncationWarningThresholdChars = 100;
const skillBundleResourceDirs = ["scripts", "references", "assets"];
const pluginManifestPaths = [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"];
const skillsIntroWithAbsolutePaths = "A skill is a set of instructions provided through a `SKILL.md` source. Below is the list of skills that can be used. Each entry includes a name, description, and source locator. `file` locators are on the host filesystem, `environment resource` locators are owned by an execution environment, `orchestrator resource` locators are opaque non-filesystem resources, and `custom resource` locators use their provider's access mechanism.";
const skillsIntroWithAliases = "A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and a short path that can be expanded into an absolute path using the skill roots table.";

type RenderableSkillLine = {
  skill: SkillRecord;
  path: string;
};

type RenderedSkillsMetadata = {
  lines: string[];
  rootLines: string[];
  aliases: Record<string, string>;
  report: SkillsRenderReport;
};

type AliasPlan = {
  rootLines: string[];
  rootAliases: Map<string, string>;
  aliasRootByPath: Map<string, string>;
  tableCost: number;
};

type RuntimeSkillsConfig = {
  includeInstructions: boolean;
  bundledSkillsEnabled: boolean;
  rules: SkillConfigRule[];
};

export function skillsRoot(): string {
  return process.env.HATCH_TS_SKILLS_ROOT ?? defaultSkillsRoot;
}

export async function listSkills(options: string | SkillDiscoveryOptions = {}): Promise<SkillCatalogEntry[]> {
  const records = await discoverSkills(options);
  const prompt = typeof options === "string" ? undefined : options.prompt;
  return visibleSkillsForPrompt(records, prompt).map(toCatalogEntry);
}

export async function includeSkillInstructions(): Promise<boolean> {
  return (await loadRuntimeSkillsConfig()).includeInstructions;
}

export async function discoverSkills(options: string | SkillDiscoveryOptions = {}): Promise<SkillRecord[]> {
  const roots = typeof options === "string"
    ? [{ path: options, scope: "custom" as const, followSymlinks: true }]
    : await skillSearchRoots(options);
  const all: SkillRecord[] = [];

  for (const root of dedupeRoots(roots)) {
    all.push(...await loadSkillRoot(root));
  }

  const deduped = await dedupeSkillsByPath(all);
  const disabledPaths = await loadDisabledSkillPaths(deduped);
  return deduped
    .map((skill) => ({
      ...skill,
      enabled: !disabledPaths.has(path.resolve(skill.path))
    }))
    .filter((skill) => skill.enabled && skillMatchesCurrentProduct(skill))
    .sort(compareSkillsForPrompt);
}

export async function loadSkillByPath(skillPath: string, resourceRoots?: string[]): Promise<Skill> {
  const absolute = await assertSkillResourcePath(skillPath, resourceRoots);
  const raw = await readFile(absolute, "utf8");
  const directory = path.dirname(absolute);
  const parsed = parseSkillMarkdownWithDirectory(raw, await pluginNamespaceForSkillPath(absolute), path.basename(directory));
  const root = resourceRoots?.find((candidate) => isPathInsideRoot(absolute, candidate)) ?? directory;
  const openai = await loadOpenAIMetadata(directory);
  return {
    id: skillId(absolute),
    name: parsed.manifest.name,
    description: parsed.manifest.description,
    shortDescription: parsed.shortDescription,
    path: absolute,
    directory,
    root,
    scope: "custom",
    manifest: parsed.manifest,
    openai,
    enabled: true,
    diagnostics: [],
    instructions: parsed.instructions
  };
}

export async function readSkillResourceByPath(resourcePath: string, resourceRoots?: string[]): Promise<string> {
  return readFile(await assertSkillResourcePath(resourcePath, resourceRoots), "utf8");
}

export async function listSkillResourceDirectory(resourcePath: string, resourceRoots?: string[]): Promise<Record<string, unknown>> {
  const dir = await assertSkillResourcePath(resourcePath, resourceRoots);
  const entries = await readdir(dir, { withFileTypes: true });
  return {
    entries: await Promise.all(entries.map(async (entry) => {
      const absolute = path.join(dir, entry.name);
      const info = await stat(absolute);
      return {
        path: absolute,
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        len: info.size
      };
    }))
  };
}

export function skillResourceRoots(skills: SkillRecord[]): string[] {
  return [...new Set(skills.map((skill) => skill.directory))];
}

export async function listSkillBundleResourcePaths(skillDirectory: string): Promise<SkillBundleResourceManifest> {
  const root = await realpath(skillDirectory).catch(() => path.resolve(skillDirectory));
  const files: string[] = [];
  const limit = maxSkillResourceManifestFiles + 1;

  for (const dirname of skillBundleResourceDirs) {
    if (files.length >= limit) break;
    const dir = path.join(root, dirname);
    await collectSkillBundleResourceFiles(root, dir, dirname, files, limit);
  }

  return {
    paths: files.slice(0, maxSkillResourceManifestFiles).sort(),
    truncated: files.length > maxSkillResourceManifestFiles
  };
}

export function isSkillResourcePath(candidate: string, resourceRoots: string[]): boolean {
  if (!candidate || !path.isAbsolute(candidate)) return false;
  return resourceRoots.some((root) => isPathInsideRoot(path.resolve(candidate), root));
}

export function visibleSkillsForPrompt(skills: SkillRecord[], prompt = ""): SkillRecord[] {
  if (!prompt) return visibleSkillsForSession(skills);
  const explicit = explicitSkillReferences(prompt, skills.map((skill) => skill.name));
  return skills.filter((skill) => skill.openai.policy.allowImplicitInvocation || explicitSkillReferenceMatches(skill, explicit));
}

export function visibleSkillsForSession(skills: SkillRecord[]): SkillRecord[] {
  return skills.filter((skill) => skill.openai.policy.allowImplicitInvocation);
}

function skillMatchesCurrentProduct(skill: SkillRecord): boolean {
  const products = skill.openai.policy.products;
  if (products.length === 0) return true;
  const currentProduct = currentRestrictionProduct();
  return currentProduct ? products.some((product) => normalizeProduct(product) === currentProduct) : false;
}

function currentRestrictionProduct(): string | undefined {
  return normalizeProduct(process.env.HATCH_SKILL_PRODUCT ?? "");
}

function normalizeProduct(value: string): "codex" | "chatgpt" | "atlas" | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "codex" || normalized === "chatgpt" || normalized === "atlas") {
    return normalized;
  }
  return undefined;
}

export async function detectImplicitSkillInvocationForCommand(
  skills: SkillRecord[],
  command: string,
  workdir: string
): Promise<ImplicitSkillInvocation | undefined> {
  const resolvedWorkdir = path.resolve(workdir);
  const tokens = tokenizeCommand(command);
  const scriptToken = scriptRunToken(tokens);
  if (scriptToken) {
    const scriptPath = await canonicalPath(path.resolve(resolvedWorkdir, scriptToken));
    const scriptSkill = await skillForScriptPath(skills, scriptPath);
    if (scriptSkill) {
      return {
        skill: scriptSkill,
        reason: "script_run",
        path: scriptPath
      };
    }
  }

  for (const token of commandReadPathTokens(tokens)) {
    const invocation = await detectImplicitSkillInvocationForPath(skills, token, resolvedWorkdir);
    if (invocation) return invocation;
  }

  return undefined;
}

export async function detectImplicitSkillInvocationForPath(
  skills: SkillRecord[],
  target: string,
  workdir: string
): Promise<ImplicitSkillInvocation | undefined> {
  if (!target) return undefined;
  const candidate = await canonicalPath(path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(workdir, target));
  const skill = await skillForDocumentPath(skills, candidate);
  return skill
    ? {
        skill,
        reason: "skill_doc_read",
        path: candidate
      }
    : undefined;
}

export function explicitSkillMentions(prompt: string, _candidateNames: string[] = []): Set<string> {
  return explicitSkillReferences(prompt, _candidateNames).names;
}

export type ExplicitSkillReferences = {
  names: Set<string>;
  paths: Set<string>;
};

export function explicitSkillReferences(prompt: string, candidateNames: string[] = []): ExplicitSkillReferences {
  const linked = explicitLinkedSkillMentions(prompt);
  const rawNames = explicitDollarSkillMentions(prompt);
  const counts = candidateNameCounts(candidateNames);
  const names = new Set<string>();
  for (const name of rawNames) {
    if (!name) continue;
    if (counts.size > 0 && counts.get(name) !== 1) continue;
    names.add(name);
  }
  return {
    names,
    paths: linked.paths
  };
}

export function explicitSkillReferenceMatches(skill: SkillRecord, references: ExplicitSkillReferences): boolean {
  return references.names.has(skill.name) || references.paths.has(normalizeExplicitSkillPath(skill.path));
}

export function explicitLinkedSkillMentions(prompt: string): ExplicitSkillReferences {
  const linked = explicitLinkedToolMentionRanges(prompt);
  return {
    names: linked.names,
    paths: linked.paths
  };
}

function explicitLinkedToolMentionRanges(prompt: string): ExplicitSkillReferences & { ranges: Array<[number, number]> } {
  const names = new Set<string>();
  const paths = new Set<string>();
  const ranges: Array<[number, number]> = [];
  for (const match of prompt.matchAll(/\[\$([A-Za-z0-9_:-]+)\]\s*\(([^)]*)\)/g)) {
    const name = match[1] ?? "";
    const rawPath = (match[2] ?? "").trim();
    if (!name || !rawPath) continue;
    const index = match.index;
    ranges.push([index, index + match[0].length]);
    if (isCommonEnvVarMention(name) || isNonSkillMentionPath(rawPath)) continue;
    names.add(name);
    paths.add(normalizeExplicitSkillPath(rawPath));
  }
  return { names, paths, ranges };
}

export function explicitRawSkillMentions(prompt: string, _candidateNames: string[] = []): Set<string> {
  return new Set(explicitDollarSkillMentions(prompt));
}

export function explicitDollarSkillMentions(prompt: string): Set<string> {
  const names = new Set<string>();
  const linkedRanges = explicitLinkedToolMentionRanges(prompt).ranges;
  let index = 0;
  while (index < prompt.length) {
    if (prompt[index] !== "$") {
      index += 1;
      continue;
    }
    const linkedRange = linkedRanges.find(([start, end]) => index >= start && index < end);
    if (linkedRange) {
      index = linkedRange[1];
      continue;
    }
    const nameStart = index + 1;
    const firstChar = prompt.charCodeAt(nameStart);
    if (!isMentionNameChar(firstChar)) {
      index += 1;
      continue;
    }
    let nameEnd = nameStart + 1;
    while (isMentionNameChar(prompt.charCodeAt(nameEnd))) {
      nameEnd += 1;
    }
    const name = prompt.slice(nameStart, nameEnd);
    if (name && !isCommonEnvVarMention(name)) {
      names.add(name);
    }
    index = nameEnd;
  }
  return names;
}

export function renderSkillsSection(
  skills: SkillRecord[],
  options: {
    budgetChars?: number;
    contextWindowChars?: number;
    prompt?: string;
    filterByPrompt?: boolean;
    executionMode?: "direct" | "protected";
  } = {}
): SkillsRenderResult {
  const filtered = options.filterByPrompt
    ? visibleSkillsForPrompt(skills, options.prompt)
    : skills;
  if (filtered.length === 0) {
    return {
      section: "",
      aliases: {},
      report: {
        total_count: 0,
        included_count: 0,
        omitted_count: 0,
        truncated_description_chars: 0,
        truncated_description_count: 0
      }
    };
  }

  const rendered = renderSkillsMetadata(filtered, options.budgetChars ?? skillMetadataCharBudget(options.contextWindowChars));
  const { lines, rootLines, aliases, report } = rendered;
  const usesAliases = rootLines.length > 0;
  return {
    section: [
      "## Skills",
      usesAliases ? skillsIntroWithAliases : skillsIntroWithAbsolutePaths,
      ...(usesAliases ? ["### Skill roots", ...rootLines] : []),
      "### Available skills",
      ...lines,
      ...(report.warning_message ? [`Warning: ${report.warning_message}`] : []),
      "### How to use skills",
      skillsHowToUse(usesAliases, options.executionMode === "protected")
    ].join("\n"),
    aliases,
    report
  };
}

export function skillMetadataCharBudget(contextWindowChars?: number): number {
  const explicitBudget = positiveIntegerEnv("HATCH_SKILL_METADATA_BUDGET_CHARS");
  if (explicitBudget !== undefined) return explicitBudget;

  const contextWindow = positiveInteger(contextWindowChars)
    ?? positiveIntegerEnv("HATCH_MODEL_CONTEXT_WINDOW_CHARS");
  if (contextWindow !== undefined) {
    return Math.max(1, Math.floor(contextWindow * skillMetadataContextWindowFraction));
  }

  return fallbackSkillMetadataCharBudget;
}

export function toCatalogEntry(skill: SkillRecord): SkillCatalogEntry {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    path: skill.path
  };
}

async function skillSearchRoots(options: SkillDiscoveryOptions): Promise<SkillRoot[]> {
  const bundledSkillsEnabled = await loadBundledSkillsEnabled();
  if (process.env.HATCH_TS_SKILLS_ROOT) {
    return bundledSkillsEnabled ? [{
      path: path.resolve(process.env.HATCH_TS_SKILLS_ROOT),
      scope: "system",
      followSymlinks: true
    }] : [];
  }

  const roots: SkillRoot[] = [];
  roots.push(...(options.roots ?? []).map((root) => ({
    path: path.resolve(root.path),
    scope: root.scope ?? "custom",
    followSymlinks: root.followSymlinks ?? true
  })));
  if (process.env.HATCH_SKILL_ROOTS) {
    roots.push(...process.env.HATCH_SKILL_ROOTS.split(path.delimiter)
      .filter(Boolean)
      .map((root) => ({ path: path.resolve(root), scope: "user" as const, followSymlinks: true })));
  }

  if (bundledSkillsEnabled) {
    roots.push({
      path: defaultSkillsRoot,
      scope: "system",
      followSymlinks: true
    });
  }
  return roots;
}

async function readPluginManifest(pluginRoot: string): Promise<Record<string, unknown> | undefined> {
  for (const relativePath of pluginManifestPaths) {
    const manifestPath = path.join(pluginRoot, relativePath);
    const raw = await readFile(manifestPath, "utf8").catch(() => undefined);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function pluginNamespaceFromManifest(pluginRoot: string, manifest: Record<string, unknown>): string {
  const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
  return name || path.basename(pluginRoot);
}

async function pluginNamespaceForSkillPath(skillPath: string): Promise<string | undefined> {
  let current = path.dirname(path.resolve(skillPath));
  while (true) {
    const manifest = await readPluginManifest(current);
    if (manifest) return pluginNamespaceFromManifest(current, manifest);
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  let escaping = false;
  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((char === "\"" || char === "'") && (!quote || quote === char)) {
      quote = quote ? undefined : char;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function scriptRunToken(tokens: string[]): string | undefined {
  const runners = new Set(["python", "python3", "bash", "zsh", "sh", "node", "deno", "ruby", "perl", "pwsh"]);
  const scriptExtensions = [".py", ".sh", ".js", ".ts", ".rb", ".pl", ".ps1"];
  const runner = path.basename(tokens[0] ?? "").toLowerCase().replace(/\.exe$/, "");
  if (!runners.has(runner)) return undefined;
  for (const token of tokens.slice(1)) {
    if (token === "--" || token.startsWith("-")) continue;
    return scriptExtensions.some((extension) => token.toLowerCase().endsWith(extension))
      ? token
      : undefined;
  }
  return undefined;
}

function commandReadPathTokens(tokens: string[]): string[] {
  const ignored = new Set(["|", "||", "&&", ";", "<", ">", ">>", "2>", "2>>"]);
  return tokens.filter((token) => (
    token
    && !ignored.has(token)
    && !token.startsWith("-")
    && /(?:^|[/\\])SKILL\.md$/i.test(token)
  ));
}

async function skillForScriptPath(skills: SkillRecord[], scriptPath: string): Promise<SkillRecord | undefined> {
  for (const skill of skills) {
    const scriptsDir = await canonicalPath(path.join(skill.directory, "scripts"));
    if (isPathInsideRoot(scriptPath, scriptsDir)) {
      return skill;
    }
  }
  return undefined;
}

async function skillForDocumentPath(skills: SkillRecord[], documentPath: string): Promise<SkillRecord | undefined> {
  for (const skill of skills) {
    const skillPath = await canonicalPath(skill.path);
    if (documentPath === skillPath) {
      return skill;
    }
  }
  return undefined;
}

async function canonicalPath(target: string): Promise<string> {
  return realpath(target).catch(() => path.resolve(target));
}

async function loadSkillRoot(root: SkillRoot): Promise<SkillRecord[]> {
  if (!await exists(root.path)) {
    return [];
  }
  const rootPath = await realpath(root.path).catch(() => path.resolve(root.path));
  const files = await discoverSkillFiles(rootPath, root.followSymlinks);
  const records: SkillRecord[] = [];

  for (const file of files) {
    const raw = await readFile(file, "utf8").catch(() => undefined);
    if (!raw) continue;

    try {
      const directory = path.dirname(file);
      const parsed = parseSkillMarkdownWithDirectory(
        raw,
        root.pluginNamespace ?? await pluginNamespaceForSkillPath(file),
        path.basename(directory)
      );
      const openai = await loadOpenAIMetadata(directory);
      records.push({
        id: skillId(file),
        name: parsed.manifest.name,
        description: parsed.manifest.description,
        shortDescription: parsed.shortDescription ?? openai.interface?.shortDescription,
        path: file,
        directory,
        root: rootPath,
        scope: root.scope,
        manifest: parsed.manifest,
        openai,
        enabled: true,
        diagnostics: []
      });
    } catch (error) {
      // Invalid skills are skipped; this mirrors Codex's behavior of surfacing a
      // load error without making malformed metadata model-visible.
    }
  }

  return records;
}

async function dedupeSkillsByPath(skills: SkillRecord[]): Promise<SkillRecord[]> {
  const seen = new Set<string>();
  const deduped: SkillRecord[] = [];
  for (const skill of skills) {
    const canonical = await canonicalSkillConfigPath(skill.path);
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    deduped.push(skill);
  }
  return deduped;
}

async function discoverSkillFiles(root: string, followSymlinks: boolean): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let scanned = 0;

  while (queue.length > 0 && scanned < maxSkillDirsPerRoot) {
    const item = queue.shift();
    if (!item || item.depth > maxScanDepth) continue;
    const realDir = await realpath(item.dir).catch(() => path.resolve(item.dir));
    if (visited.has(realDir)) continue;
    visited.add(realDir);
    scanned += 1;

    const entries = await readdir(item.dir, { withFileTypes: true }).catch(() => []);
    const hasSkillFile = entries.some((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (hasSkillFile) {
      files.push(path.join(realDir, "SKILL.md"));
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      const next = path.join(item.dir, entry.name);
      if (entry.isDirectory()) {
        queue.push({ dir: next, depth: item.depth + 1 });
      } else if (entry.isSymbolicLink() && followSymlinks && await isDirectory(next)) {
        queue.push({ dir: next, depth: item.depth + 1 });
      }
    }
  }

  return files.sort();
}

async function collectSkillBundleResourceFiles(root: string, dir: string, relativeDir: string, files: string[], limit: number): Promise<void> {
  if (files.length >= limit || !isPathInsideRoot(path.resolve(dir), root)) {
    return;
  }

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (files.length >= limit) break;
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const absolute = path.join(dir, entry.name);
    const relative = path.posix.join(relativeDir.split(path.sep).join("/"), entry.name);
    if (entry.isFile()) {
      files.push(relative);
    } else if (entry.isDirectory()) {
      await collectSkillBundleResourceFiles(root, absolute, relative, files, limit);
    } else if (entry.isSymbolicLink() && await isDirectory(absolute)) {
      const target = await realpath(absolute).catch(() => undefined);
      if (target && isPathInsideRoot(target, root)) {
        await collectSkillBundleResourceFiles(root, target, relative, files, limit);
      }
    }
  }
}

export function parseSkillMarkdown(source: string, pluginNamespace?: string): ParsedSkillMarkdown {
  return parseSkillMarkdownWithDirectory(source, pluginNamespace);
}

function parseSkillMarkdownWithDirectory(
  source: string,
  pluginNamespace?: string,
  directoryName?: string
): ParsedSkillMarkdown {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    throw new Error("SKILL.md must start with YAML frontmatter delimited by ---");
  }

  const frontmatter = parseFrontmatter(match[1] ?? "");
  const baseName = requiredSkillStringField(frontmatter, "name");
  if (!baseName) throw new Error("SKILL.md frontmatter requires name");
  const name = pluginNamespace ? `${pluginNamespace}:${baseName}` : baseName;
  const description = requiredSkillStringField(frontmatter, "description");
  if (!description) throw new Error("SKILL.md frontmatter requires description");

  validateAgentSkillName(baseName, "name", 64);
  validateQualifiedSkillName(name, "qualified name", 128);
  if (directoryName && baseName !== directoryName) {
    throw new Error(`SKILL.md frontmatter name must match parent directory name (${directoryName})`);
  }
  validateLength(description, 1, maxDescriptionChars, "description");

  const compatibility = optionalSkillStringField(frontmatter, "compatibility");
  if (compatibility) validateLength(compatibility, 1, 500, "compatibility");
  const metadata = skillMetadataField(frontmatter.metadata);
  const shortDescription = optionalStringField(metadata, "short-description");
  if (shortDescription) validateLength(shortDescription, 1, maxDescriptionChars, "metadata.short-description");

  return {
    manifest: {
      name,
      description,
      license: optionalSkillStringField(frontmatter, "license"),
      compatibility,
      metadata,
      allowedTools: optionalSkillStringField(frontmatter, "allowed-tools")
    },
    shortDescription,
    instructions: (match[2] ?? "").trim()
  };
}

function parseFrontmatter(source: string): Record<string, unknown> {
  const parsed = parseYaml(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SKILL.md frontmatter must be a YAML mapping");
  }
  return parsed as Record<string, unknown>;
}

async function loadOpenAIMetadata(skillDirectory: string): Promise<SkillOpenAIMetadata> {
  const empty = defaultOpenAIMetadata();
  const file = path.join(skillDirectory, "agents", "openai.yaml");
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (!raw) return empty;

  try {
    const parsed = parseYaml(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return empty;
    }
    const source = parsed as Record<string, unknown>;
    return {
      interface: parseInterface(source.interface),
      policy: parsePolicy(source.policy),
      dependencies: parseDependencies(source.dependencies)
    };
  } catch {
    return empty;
  }
}

function defaultOpenAIMetadata(): SkillOpenAIMetadata {
  return {
    policy: {
      allowImplicitInvocation: true,
      products: []
    },
    dependencies: {
      tools: []
    }
  };
}

function parseInterface(source: unknown): SkillInterface | undefined {
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const record = source as Record<string, unknown>;
  const iface: SkillInterface = {
    displayName: optionalStringField(record, "display_name"),
    shortDescription: optionalStringField(record, "short_description"),
    iconSmall: optionalStringField(record, "icon_small"),
    iconLarge: optionalStringField(record, "icon_large"),
    brandColor: optionalStringField(record, "brand_color"),
    defaultPrompt: optionalStringField(record, "default_prompt")
  };
  return Object.values(iface).some((value) => value !== undefined) ? iface : undefined;
}

function parsePolicy(source: unknown): SkillPolicy {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {
      allowImplicitInvocation: true,
      products: []
    };
  }
  const record = source as Record<string, unknown>;
  const allow = record.allow_implicit_invocation;
  const products = Array.isArray(record.products)
    ? record.products.filter((value): value is string => typeof value === "string")
    : [];
  return {
    allowImplicitInvocation: typeof allow === "boolean" ? allow : true,
    products
  };
}

function parseDependencies(source: unknown): { tools: SkillToolDependency[] } {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { tools: [] };
  }
  const tools = (source as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) {
    return { tools: [] };
  }
  return {
    tools: tools
      .filter((tool): tool is Record<string, unknown> => Boolean(tool) && typeof tool === "object" && !Array.isArray(tool))
      .map((tool) => ({
        type: stringField(tool, "type"),
        value: stringField(tool, "value"),
        description: optionalStringField(tool, "description"),
        transport: optionalStringField(tool, "transport"),
        command: optionalStringField(tool, "command"),
        url: optionalStringField(tool, "url")
      }))
      .filter((tool) => tool.type && tool.value)
  };
}

type SkillConfigRule =
  | { selector: "path"; path: string; enabled: boolean }
  | { selector: "name"; name: string; enabled: boolean };

async function loadDisabledSkillPaths(skills: SkillRecord[]): Promise<Set<string>> {
  return resolveDisabledSkillPaths(skills, (await loadRuntimeSkillsConfig()).rules);
}

async function loadBundledSkillsEnabled(): Promise<boolean> {
  return (await loadRuntimeSkillsConfig()).bundledSkillsEnabled;
}

async function loadRuntimeSkillsConfig(): Promise<RuntimeSkillsConfig> {
  const configPath = process.env.HATCH_SKILLS_CONFIG ?? "";
  if (!configPath) return defaultRuntimeSkillsConfig();
  const raw = await readFile(configPath, "utf8").catch(() => "");
  if (!raw) return defaultRuntimeSkillsConfig();
  return parseRuntimeSkillsConfig(raw, path.dirname(configPath));
}

async function resolveDisabledSkillPaths(skills: SkillRecord[], rules: SkillConfigRule[]): Promise<Set<string>> {
  const disabled = new Set<string>();
  const skillPathByName = new Map<string, string[]>();
  for (const skill of skills) {
    const canonical = await canonicalSkillConfigPath(skill.path);
    skillPathByName.set(skill.name, [...(skillPathByName.get(skill.name) ?? []), canonical]);
  }

  for (const rule of rules) {
    const paths = rule.selector === "path"
      ? [await canonicalSkillConfigPath(rule.path)]
      : skillPathByName.get(rule.name) ?? [];
    for (const target of paths) {
      if (rule.enabled) {
        disabled.delete(target);
      } else {
        disabled.add(target);
      }
    }
  }

  return disabled;
}

function defaultRuntimeSkillsConfig(): RuntimeSkillsConfig {
  return {
    includeInstructions: true,
    bundledSkillsEnabled: true,
    rules: []
  };
}

function parseRuntimeSkillsConfig(source: string, baseDir: string): RuntimeSkillsConfig {
  const config = defaultRuntimeSkillsConfig();
  const rules: SkillConfigRule[] = [];
  let current: { path?: string; name?: string; enabled?: boolean } | undefined;
  let section: "skills" | "skills.bundled" | "skills.config" | undefined;

  const flush = () => {
    if (!current || typeof current.enabled !== "boolean") {
      current = undefined;
      return;
    }
    if (current.path && !current.name) {
      upsertSkillConfigRule(rules, {
        selector: "path",
        path: path.resolve(baseDir, current.path),
        enabled: current.enabled
      });
    } else if (current.name && !current.path && current.name.trim()) {
      upsertSkillConfigRule(rules, {
        selector: "name",
        name: current.name.trim(),
        enabled: current.enabled
      });
    }
    current = undefined;
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (line === "[skills]") {
      flush();
      section = "skills";
      continue;
    }
    if (line === "[skills.bundled]") {
      flush();
      section = "skills.bundled";
      continue;
    }
    if (line === "[[skills.config]]") {
      flush();
      section = "skills.config";
      current = {};
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (section === "skills") {
      if (key === "include_instructions") {
        config.includeInstructions = parseTomlBoolean(rawValue) ?? config.includeInstructions;
      }
      continue;
    }
    if (section === "skills.bundled") {
      if (key === "enabled") {
        config.bundledSkillsEnabled = parseTomlBoolean(rawValue) ?? config.bundledSkillsEnabled;
      }
      continue;
    }
    if (section === "skills.config" && current) {
      if (key === "path") {
        current.path = unquoteTomlString(rawValue);
      } else if (key === "name") {
        current.name = unquoteTomlString(rawValue);
      } else if (key === "enabled") {
        current.enabled = parseTomlBoolean(rawValue);
      }
    }
  }
  flush();
  return {
    ...config,
    rules
  };
}

function upsertSkillConfigRule(rules: SkillConfigRule[], rule: SkillConfigRule): void {
  const key = skillConfigRuleKey(rule);
  const previous = rules.findIndex((item) => skillConfigRuleKey(item) === key);
  if (previous >= 0) {
    rules.splice(previous, 1);
  }
  rules.push(rule);
}

function skillConfigRuleKey(rule: SkillConfigRule): string {
  return rule.selector === "path"
    ? `path:${path.resolve(rule.path)}`
    : `name:${rule.name}`;
}

function parseTomlBoolean(value: string): boolean | undefined {
  const trimmed = value.trim();
  return trimmed === "true" ? true : trimmed === "false" ? false : undefined;
}

function unquoteTomlString(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

async function canonicalSkillConfigPath(skillPath: string): Promise<string> {
  return realpath(skillPath).catch(() => path.resolve(skillPath));
}

function renderSkillsMetadata(skills: SkillRecord[], budgetChars: number): RenderedSkillsMetadata {
  const absolute = {
    ...renderSkillLines(skills.map((skill) => ({ skill, path: skill.path })), budgetChars),
    rootLines: [],
    aliases: {}
  };
  if (absolute.report.omitted_count === 0 && absolute.report.truncated_description_chars === 0) {
    return absolute;
  }

  const aliased = renderAliasedSkillLines(skills, budgetChars);
  if (!aliased) return absolute;

  return aliasedRenderIsBetter(aliased, absolute) ? aliased : absolute;
}

function renderAliasedSkillLines(skills: SkillRecord[], budgetChars: number): RenderedSkillsMetadata | undefined {
  const plan = buildAliasPlan(skills, budgetChars);
  if (!plan || plan.tableCost >= budgetChars) {
    return undefined;
  }

  return {
    ...renderSkillLines(skills.map((skill) => ({
      skill,
      path: renderSkillPathWithAliases(skill, plan)
    })), budgetChars - plan.tableCost),
    rootLines: plan.rootLines,
    aliases: skillAliasRoots(plan)
  };
}

function renderSkillLines(skillLines: RenderableSkillLine[], budgetChars: number): { lines: string[]; report: SkillsRenderReport } {
  const ordered = [...skillLines].sort((left, right) => compareSkillsForPrompt(left.skill, right.skill));
  const fullCost = ordered.reduce((sum, line) => sum + skillLineCost(renderSkillLine(line, line.skill.description)), 0);
  if (fullCost <= budgetChars) {
    const lines = ordered.map((line) => renderSkillLine(line, line.skill.description));
    return {
      lines,
      report: {
        total_count: ordered.length,
        included_count: ordered.length,
        omitted_count: 0,
        truncated_description_chars: 0,
        truncated_description_count: 0
      }
    };
  }

  const minimumLines = ordered.map((line) => renderSkillLine(line, ""));
  const minimumCost = minimumLines.reduce((sum, line) => sum + skillLineCost(line), 0);
  if (minimumCost <= budgetChars) {
    const rendered = renderLinesWithDescriptionBudget(ordered, budgetChars - minimumCost);
    const truncatedChars = rendered.reduce((sum, line) => sum + line.truncatedChars, 0);
    const truncatedCount = rendered.filter((line) => line.truncatedChars > 0).length;
    return {
      lines: rendered.map((line) => line.line),
      report: {
        total_count: ordered.length,
        included_count: ordered.length,
        omitted_count: 0,
        truncated_description_chars: truncatedChars,
        truncated_description_count: truncatedCount,
        ...(averageTruncatedDescriptionChars(ordered.length, truncatedChars) > skillDescriptionTruncationWarningThresholdChars
          ? { warning_message: "Skill descriptions were shortened to fit the skills context budget. The model can still see every skill, but some descriptions are shorter. Disable unused skills to leave more room for the rest." }
          : {})
      }
    };
  }

  const lines: string[] = [];
  let used = 0;
  for (const line of minimumLines) {
    const next = used + skillLineCost(line);
    if (next > budgetChars) break;
    lines.push(line);
    used = next;
  }

  return {
    lines,
    report: {
      total_count: ordered.length,
      included_count: lines.length,
      omitted_count: ordered.length - lines.length,
      truncated_description_chars: ordered.reduce((sum, line) => sum + line.skill.description.length, 0),
      truncated_description_count: ordered.filter((line) => line.skill.description.length > 0).length,
      warning_message: `Exceeded skills context budget. All skill descriptions were removed and ${ordered.length - lines.length} additional skill(s) were not included in the model-visible skills list.`
    }
  };
}

function renderLinesWithDescriptionBudget(skillLines: RenderableSkillLine[], limit: number): Array<{ line: string; truncatedChars: number }> {
  const budgets = skillLines.map((line) => {
    const descriptionChars = Array.from(line.skill.description);
    const minimumCost = skillLineCost(renderSkillLine(line, ""));
    const extraCosts = [0];
    for (let index = 1; index <= descriptionChars.length; index += 1) {
      const description = descriptionChars.slice(0, index).join("");
      extraCosts.push(skillLineCost(renderSkillLine(line, description)) - minimumCost);
    }
    return {
      line,
      descriptionChars,
      extraCosts
    };
  });

  const allocations = budgets.map(() => 0);
  const currentExtraCosts = budgets.map(() => 0);
  let remaining = Math.max(0, limit);

  while (true) {
    let changed = false;
    for (const [index, budget] of budgets.entries()) {
      if (allocations[index] >= budget.descriptionChars.length) {
        continue;
      }
      const nextChars = allocations[index] + 1;
      const nextCost = budget.extraCosts[nextChars] ?? Number.POSITIVE_INFINITY;
      const delta = nextCost - currentExtraCosts[index];
      if (delta <= remaining) {
        allocations[index] = nextChars;
        currentExtraCosts[index] = nextCost;
        remaining -= delta;
        changed = true;
      }
    }
    if (!changed) break;
  }

  return budgets.map((budget, index) => {
    const allocated = allocations[index];
    const description = budget.descriptionChars.slice(0, allocated).join("");
    return {
      line: renderSkillLine(budget.line, description),
      truncatedChars: budget.descriptionChars.length - allocated
    };
  });
}

function buildAliasPlan(skills: SkillRecord[], budgetChars: number): AliasPlan | undefined {
  const ordered = [...skills].sort(compareSkillsForPrompt);
  const skillRootByPath = new Map<string, string>();
  const usedRoots: string[] = [];
  const seenRoots = new Set<string>();
  for (const skill of ordered) {
    const root = path.resolve(skill.root);
    skillRootByPath.set(path.resolve(skill.path), root);
    if (!seenRoots.has(root)) {
      seenRoots.add(root);
      usedRoots.push(root);
    }
  }
  if (usedRoots.length === 0) return undefined;

  const pluginVersionCounts = pluginVersionSkillCountsForSkillRoots(skillRootByPath.values());
  const aliasRootBySkillRoot = new Map<string, string>();
  for (const root of usedRoots) {
    aliasRootBySkillRoot.set(root, aliasRootForSkillRoot(root, pluginVersionCounts));
  }

  const aliasRoots: string[] = [];
  const seenAliasRoots = new Set<string>();
  for (const root of usedRoots) {
    const aliasRoot = aliasRootBySkillRoot.get(root);
    if (!aliasRoot || seenAliasRoots.has(aliasRoot)) continue;
    seenAliasRoots.add(aliasRoot);
    aliasRoots.push(aliasRoot);
  }
  if (aliasRoots.length === 0) return undefined;

  const rootAliases = new Map(aliasRoots.map((root, index) => [root, `r${index}`]));
  const aliasRootByPath = new Map<string, string>();
  for (const [skillPath, skillRoot] of skillRootByPath.entries()) {
    const aliasRoot = aliasRootBySkillRoot.get(skillRoot);
    if (aliasRoot) aliasRootByPath.set(skillPath, aliasRoot);
  }
  const rootLines = aliasRoots.map((root, index) => `- \`r${index}\` = \`${root.replaceAll("\\", "/")}\``);
  const tableCost = aliasedMetadataOverheadCost(rootLines);
  if (tableCost >= budgetChars) return undefined;

  return {
    rootLines,
    rootAliases,
    aliasRootByPath,
    tableCost
  };
}

function renderSkillPathWithAliases(skill: SkillRecord, plan: AliasPlan): string {
  const skillPath = path.resolve(skill.path);
  const aliasRoot = plan.aliasRootByPath.get(skillPath);
  const alias = aliasRoot ? plan.rootAliases.get(aliasRoot) : undefined;
  if (!aliasRoot || !alias) {
    return skill.path.replaceAll("\\", "/");
  }
  const relative = path.relative(aliasRoot, skillPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return skill.path.replaceAll("\\", "/");
  }
  return `${alias}/${relative.replaceAll("\\", "/")}`;
}

function skillAliasRoots(plan: AliasPlan): Record<string, string> {
  return Object.fromEntries([...plan.rootAliases.entries()].map(([root, alias]) => [
    alias,
    root.replaceAll("\\", "/")
  ]));
}

function aliasRootForSkillRoot(root: string, pluginVersionCounts: Map<string, number>): string {
  const pluginVersionBasePath = pluginVersionBase(root);
  if (!pluginVersionBasePath) return root;
  if ((pluginVersionCounts.get(pluginVersionBasePath) ?? 0) > 1) {
    return root;
  }
  return pluginMarketplaceBase(root) ?? root;
}

function pluginVersionSkillCountsForSkillRoots(skillRoots: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const root of skillRoots) {
    const base = pluginVersionBase(root);
    if (!base) continue;
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return counts;
}

function pluginMarketplaceBase(inputPath: string): string | undefined {
  let candidate = path.resolve(inputPath);
  while (true) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return undefined;
    if (path.basename(parent) === "cache" && path.basename(path.dirname(parent)) === "plugins") {
      return candidate;
    }
    candidate = parent;
  }
}

function pluginVersionBase(inputPath: string): string | undefined {
  const marketplaceBase = pluginMarketplaceBase(inputPath);
  if (!marketplaceBase) return undefined;
  const relative = path.relative(marketplaceBase, path.resolve(inputPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length < 2) return undefined;
  return path.join(marketplaceBase, parts[0] ?? "", parts[1] ?? "");
}

function aliasedMetadataOverheadCost(rootLines: string[]): number {
  return Math.max(0, sectionPreambleCost(rootLines) - sectionPreambleCost([]));
}

function sectionPreambleCost(rootLines: string[]): number {
  return Array.from([
    "## Skills",
    rootLines.length > 0 ? skillsIntroWithAliases : skillsIntroWithAbsolutePaths,
    ...(rootLines.length > 0 ? ["### Skill roots", ...rootLines] : []),
    "### Available skills"
  ].join("\n")).length;
}

function aliasedRenderIsBetter(
  aliased: RenderedSkillsMetadata,
  absolute: RenderedSkillsMetadata
): boolean {
  if (aliased.report.included_count !== absolute.report.included_count) {
    return aliased.report.included_count > absolute.report.included_count;
  }
  if (aliased.report.truncated_description_chars !== absolute.report.truncated_description_chars) {
    return aliased.report.truncated_description_chars < absolute.report.truncated_description_chars;
  }
  return renderedSkillsCost(aliased) < renderedSkillsCost(absolute);
}

function renderedSkillsCost(rendered: RenderedSkillsMetadata): number {
  const rootCost = rendered.rootLines.length > 0 ? aliasedMetadataOverheadCost(rendered.rootLines) : 0;
  return rendered.lines.reduce((sum, line) => sum + skillLineCost(line), rootCost);
}

function skillLineCost(line: string): number {
  return Array.from(`${line}\n`).length;
}

function truncateUtf8ToBytes(value: string, maxBytes: number): string {
  let used = 0;
  let output = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (used + charBytes > maxBytes) break;
    output += char;
    used += charBytes;
  }
  return output;
}

function averageTruncatedDescriptionChars(totalCount: number, truncatedChars: number): number {
  if (totalCount === 0 || truncatedChars === 0) return 0;
  return Math.ceil(truncatedChars / totalCount);
}

function positiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  return positiveInteger(Number(raw));
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function renderSkillLine(line: RenderableSkillLine, description: string): string {
  const locator = ["file: " + line.path.replaceAll("\\", "/"), ...skillToolDependencySummary(line.skill)];
  return description
    ? `- ${line.skill.name}: ${description} (${locator.join("; ")})`
    : `- ${line.skill.name}: (${locator.join("; ")})`;
}

function skillToolDependencySummary(skill: SkillRecord): string[] {
  const tools = skill.openai.dependencies.tools;
  if (tools.length === 0) return [];
  const visible = tools.slice(0, 4).map((tool) => `${tool.type}:${tool.value}`);
  const suffix = tools.length > visible.length ? `+${tools.length - visible.length} more` : "";
  return [`tools: ${[...visible, suffix].filter(Boolean).join(", ")}`];
}

function skillsHowToUse(usesAliases: boolean, protectedMode = false): string {
  const discovery = usesAliases
    ? "- Discovery: The list above is the skills available in this session (name + description + short path). Skill bodies live on disk at the listed paths after expanding the matching alias from `### Skill roots`."
    : "- Discovery: The list above is the skills available in this session (name + description + source locator). `file` entries live on the host filesystem, `environment resource` entries are owned by their execution environment, `orchestrator resource` entries must be accessed through `skills.list` and `skills.read`, and `custom resource` entries use their provider's access mechanism.";
  const missing = usesAliases
    ? "- Missing/blocked: If a named skill isn't in the list or the expanded path can't be read, say so briefly and continue with the best fallback."
    : "- Missing/blocked: If a named skill isn't in the list or its source can't be read, say so briefly and continue with the best fallback.";
  const firstStep = protectedMode
    ? "  1. The main agent must not read a protected skill's `SKILL.md`. Call the `skill_run` function tool with the public skill id, the user's product, and exact context references."
    : usesAliases
      ? "  1. After deciding to use a skill, the main agent must expand the listed short `path` with the matching alias from `### Skill roots`, then call `file_read` with the expanded `SKILL.md` path before taking product actions. If a read is truncated or paginated, continue until EOF."
      : "  1. After deciding to use a skill, the main agent must read its `SKILL.md` completely before taking product actions. For a `file` entry, call `file_read` with the listed path. If a read is truncated or paginated, continue until EOF.";
  const secondStep = protectedMode
    ? "  2. The server creates a headless SkillRuntime session. That worker reads the private `SKILL.md` and follows its instructions."
    : usesAliases
      ? "  2. When `SKILL.md` references relative paths (e.g., `scripts/foo.py`), resolve them relative to the directory containing that expanded `SKILL.md` first, and only consider other paths if needed."
      : "  2. When `SKILL.md` references another resource, use the same access mechanism. Resolve relative paths against a filesystem-backed skill directory.";

  return [
    discovery,
    "- Trigger rules: If the user explicitly mentions a skill with `$SkillName` or a linked skill mention, use that skill for this turn. Otherwise choose skills by matching the product to the descriptions above. Multiple explicit mentions mean use them all. Do not carry skill bodies across turns unless the skill is re-mentioned or read again.",
    missing,
    "- How to use a skill (progressive disclosure):",
    firstStep,
    secondStep,
    protectedMode
      ? "  3. The worker may request the same app tools through the runtime ToolBridge; it must not execute tools directly or open a client connection."
      : "  3. If `SKILL.md` points to extra folders such as `references/`, use its routing instructions to identify the resources required for the product. The main agent must read each required instruction or reference file itself before acting on it. Do not delegate reading, summarizing, or interpreting skill instructions to a subagent. Subagents may still perform product work when the selected skill allows it.",
    protectedMode
      ? "  4. Skill resources are loaded by the worker only when the private instructions require them."
      : "  4. For filesystem-backed skills, prefer running or patching provided scripts instead of retyping large code blocks.",
    protectedMode
      ? "  5. The main agent receives the worker result and writes the user-facing response."
      : "  5. Reuse provided assets or templates through the same access mechanism instead of recreating them.",
    "- Coordination and sequencing:",
    "  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.",
    "  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.",
    "- Context hygiene:",
    "  - Progressive disclosure applies to selecting relevant files, not partially reading a selected instruction file. Do not load unrelated references, scripts, or assets.",
    "  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.",
    "  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.",
    "- Safety and fallback: If a skill can't be applied cleanly, state the issue, pick the next-best approach, and continue."
  ].join("\n");
}

function candidateNameCounts(candidateNames: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of candidateNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function isNonSkillMentionPath(value: string): boolean {
  return /^(?:app|mcp|plugin):\/\//i.test(value.trim());
}

function isCommonEnvVarMention(name: string): boolean {
  return [
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "PWD",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "TERM",
    "XDG_CONFIG_HOME"
  ].includes(name.toUpperCase());
}

function isMentionNameChar(charCode: number): boolean {
  return (charCode >= 65 && charCode <= 90)
    || (charCode >= 97 && charCode <= 122)
    || (charCode >= 48 && charCode <= 57)
    || charCode === 45
    || charCode === 58
    || charCode === 95;
}

function normalizeExplicitSkillPath(value: string): string {
  const stripped = value.trim()
    .replace(/^skill:\/\//i, "")
    .replace(/^file:\/\//i, "");
  const normalized = path.isAbsolute(stripped)
    ? path.resolve(stripped)
    : stripped;
  return normalized.replaceAll("\\", "/");
}

async function assertSkillResourcePath(resourcePath: string, resourceRoots?: string[]): Promise<string> {
  const configuredRoots = resourceRoots ?? skillResourceRoots(await discoverSkills());
  const roots = [
    ...configuredRoots.map((root) => path.resolve(root)),
    ...(await Promise.all(configuredRoots.map(async (root) => realpath(root).catch(() => path.resolve(root))))),
  ];
  const absolute = path.resolve(resourcePath);
  if (!roots.some((root) => isPathInsideRoot(absolute, root))) {
    throw new Error(`Skill resource path escapes skills root: ${resourcePath}`);
  }
  const resolved = await realpath(absolute).catch(() => absolute);
  if (!roots.some((root) => isPathInsideRoot(resolved, root))) {
    throw new Error(`Skill resource path escapes skills root: ${resourcePath}`);
  }
  return resolved;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const absolute = path.resolve(candidate);
  const absoluteRoot = path.resolve(root);
  return absolute === absoluteRoot || absolute.startsWith(`${absoluteRoot}${path.sep}`);
}

function compareSkillsForPrompt(left: SkillRecord, right: SkillRecord): number {
  return scopePromptRank(left.scope) - scopePromptRank(right.scope)
    || left.name.localeCompare(right.name)
    || left.path.localeCompare(right.path);
}

function scopePromptRank(scope: SkillScope): number {
  if (scope === "repo") return 0;
  if (scope === "user") return 1;
  if (scope === "system") return 2;
  if (scope === "admin") return 3;
  return 4;
}

function validateAgentSkillName(name: string, field: string, maxChars: number): void {
  validateLength(name, 1, maxChars, field);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`${field} must contain only lowercase letters, numbers, and single hyphen separators`);
  }
}

function validateQualifiedSkillName(name: string, field: string, maxChars: number): void {
  validateLength(name, 1, maxChars, field);
}

function validateLength(value: string, min: number, max: number, field: string): void {
  const length = Array.from(value).length;
  if (length < min || length > max) {
    throw new Error(`${field} must be ${min}-${max} characters`);
  }
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

function optionalStringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(source, key);
  return value ? value : undefined;
}

function requiredSkillStringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new Error(`SKILL.md frontmatter field \`${key}\` must be a string`);
  }
  return value.trim();
}

function optionalSkillStringField(source: Record<string, unknown>, key: string): string | undefined {
  if (!(key in source)) return undefined;
  const value = source[key];
  if (typeof value !== "string") {
    throw new Error(`SKILL.md frontmatter field \`${key}\` must be a string`);
  }
  return value.trim() || undefined;
}

function skillMetadataField(source: unknown): Record<string, string> {
  if (source === undefined) return {};
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("SKILL.md frontmatter field `metadata` must be a string map");
  }
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") {
      throw new Error(`SKILL.md frontmatter metadata.${key} must be a string`);
    }
    metadata[key] = value;
  }
  return metadata;
}

function skillId(skillPath: string): string {
  return `file:${path.resolve(skillPath).replaceAll("\\", "/")}`;
}

function dedupeRoots(roots: SkillRoot[]): SkillRoot[] {
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = path.resolve(root.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true, () => false);
}

async function isDirectory(target: string): Promise<boolean> {
  return lstat(target)
    .then((info) => info.isDirectory() || info.isSymbolicLink())
    .catch(() => false);
}
