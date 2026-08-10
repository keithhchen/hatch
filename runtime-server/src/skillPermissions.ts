import type { ClientToolName } from "./protocol.js";
import type { ActivatedSkill } from "./store.js";

export type SkillToolGrant = {
  tool: ClientToolName;
  shellPrefix?: string;
};

const toolAliases = new Map<string, ClientToolName[]>([
  ["read", ["file_read"]],
  ["file_read", ["file_read"]],
  ["list", ["file_list"]],
  ["ls", ["file_list"]],
  ["file_list", ["file_list"]],
  ["search", ["file_search"]],
  ["grep", ["file_search"]],
  ["file_search", ["file_search"]],
  ["write", ["file_write"]],
  ["file_write", ["file_write"]],
  ["edit", ["file_patch"]],
  ["multiedit", ["file_patch"]],
  ["file_patch", ["file_patch"]],
  ["shell_exec", ["shell_exec"]],
  ["git", ["git_diff"]],
  ["git_diff", ["git_diff"]]
]);

export function parseAllowedTools(source?: string): SkillToolGrant[] {
  if (!source) return [];
  const grants: SkillToolGrant[] = [];
  const seen = new Set<string>();

  for (const rawToken of splitAllowedToolTokens(source)) {
    const token = rawToken.trim();
    if (!token) continue;
    for (const grant of parseAllowedToolToken(token)) {
      const key = `${grant.tool}:${grant.shellPrefix ?? "*"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      grants.push(grant);
    }
  }

  return grants;
}

export function toolPreapprovedBySkills(
  skills: ActivatedSkill[],
  tool: ClientToolName,
  args: Record<string, unknown>
): boolean {
  return skills.some((skill) => (
    parseAllowedTools(skill.allowed_tools).some((grant) => grantMatches(grant, tool, args))
  ));
}

function parseAllowedToolToken(token: string): SkillToolGrant[] {
  const bash = token.match(/^Bash(?:\((.*)\))?$/i);
  if (bash) {
    const inner = bash[1]?.trim();
    if (!inner || inner === "*" || inner === "*:*") {
      return [{ tool: "shell_exec" }];
    }
    return splitBashPatterns(inner).flatMap((pattern) => {
      const prefix = commandPrefixPattern(pattern);
      return prefix ? [{ tool: "shell_exec" as const, shellPrefix: prefix }] : [];
    });
  }

  return toolAliases.get(token.toLowerCase())?.map((tool) => ({ tool })) ?? [];
}

function grantMatches(grant: SkillToolGrant, tool: ClientToolName, args: Record<string, unknown>): boolean {
  if (grant.tool !== tool) return false;
  if (grant.tool !== "shell_exec" || !grant.shellPrefix) return true;
  const command = typeof args.command === "string" ? args.command : "";
  return commandStartsWith(command, grant.shellPrefix);
}

function commandStartsWith(command: string, expectedPrefix: string): boolean {
  const first = command.trim().match(/^([A-Za-z0-9_./+-]+)/)?.[1];
  if (!first) return false;
  const basename = first.split(/[\\/]/).pop() ?? first;
  return basename === expectedPrefix;
}

function commandPrefixPattern(pattern: string): string | undefined {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed === "*" || trimmed === "*:*") return undefined;
  const prefix = trimmed.match(/^([A-Za-z0-9_.+-]+):\*$/)?.[1]
    ?? trimmed.match(/^([A-Za-z0-9_.+-]+)\*$/)?.[1]
    ?? trimmed.match(/^([A-Za-z0-9_.+-]+)$/)?.[1];
  return prefix?.trim();
}

function splitBashPatterns(source: string): string[] {
  return source
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitAllowedToolTokens(source: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of source) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if ((char === "," || /\s/.test(char)) && depth === 0) {
      if (current.trim()) tokens.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}
