import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadProjectDocsRuntimeConfig } from "./skills.js";

const defaultAgentsMdFilename = "AGENTS.md";
const localAgentsMdFilename = "AGENTS.override.md";

export const PROJECT_DOCS_CONTEXT_PREFIX = "# AGENTS.md instructions";

export type ProjectInstructions = {
  content: string;
  sources: string[];
};

export async function loadProjectInstructions(workspaceRoot?: string): Promise<ProjectInstructions | undefined> {
  if (!workspaceRoot) {
    return undefined;
  }
  const config = await loadProjectDocsRuntimeConfig();
  if (config.projectDocMaxBytes === 0) {
    return undefined;
  }

  const cwd = path.resolve(workspaceRoot);
  const docs = await projectDocPaths(cwd, config.projectRootMarkers, config.projectDocFallbackFilenames);
  if (docs.length === 0) {
    return undefined;
  }

  const entries: string[] = [];
  const sources: string[] = [];
  let remaining = config.projectDocMaxBytes;
  for (const docPath of docs) {
    if (remaining <= 0) {
      break;
    }
    const raw = await readFile(docPath).catch(() => undefined);
    if (!raw) {
      continue;
    }
    const data = raw.byteLength > remaining ? raw.subarray(0, remaining) : raw;
    const text = data.toString("utf8");
    if (!text.trim()) {
      continue;
    }
    entries.push(text);
    sources.push(docPath);
    remaining -= data.byteLength;
  }

  if (entries.length === 0) {
    return undefined;
  }

  return {
    content: renderProjectInstructions(cwd, entries.join("\n\n")),
    sources
  };
}

async function projectDocPaths(
  cwd: string,
  projectRootMarkers: string[],
  fallbackFilenames: string[]
): Promise<string[]> {
  const root = await findProjectRoot(cwd, projectRootMarkers);
  const dirs = dirsBetweenRootAndCwd(root, cwd);
  const names = candidateFilenames(fallbackFilenames);
  const docs: string[] = [];

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isFile(candidate)) {
        docs.push(candidate);
        break;
      }
    }
  }

  return docs;
}

async function findProjectRoot(start: string, markers: string[]): Promise<string> {
  if (markers.length === 0) {
    return start;
  }

  let current = start;
  while (true) {
    for (const marker of markers) {
      if (await exists(path.join(current, marker))) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}

function dirsBetweenRootAndCwd(root: string, cwd: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(cwd);
  const stop = path.resolve(root);
  while (true) {
    dirs.push(current);
    if (current === stop) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return dirs.reverse();
}

function candidateFilenames(fallbackFilenames: string[]): string[] {
  const names = [localAgentsMdFilename, defaultAgentsMdFilename];
  for (const fallback of fallbackFilenames) {
    if (fallback && !names.includes(fallback)) {
      names.push(fallback);
    }
  }
  return names;
}

function renderProjectInstructions(cwd: string, text: string): string {
  return [
    `${PROJECT_DOCS_CONTEXT_PREFIX} for ${cwd}`,
    "",
    "<INSTRUCTIONS>",
    text,
    "</INSTRUCTIONS>"
  ].join("\n");
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false);
}

async function isFile(target: string): Promise<boolean> {
  return stat(target).then((info) => info.isFile(), () => false);
}
