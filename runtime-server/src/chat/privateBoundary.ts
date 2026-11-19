/** What a buyer sees of the Expert's private corpus: shared by every projection that stands before a transport. */
export const protectedSkillPath = (agentId: string, name: string): string =>
  `agent://${encodeURIComponent(agentId)}/protected-skill/${encodeURIComponent(name)}`;

export const redactedTrigger = <T extends { path?: string }>(trigger: T): T => ({ ...trigger, path: trigger.path ? "agent://private" : undefined });

export const redactedToolOutput = (result: unknown) => ({ arguments: {}, result: result !== undefined ? { private_result_redacted: true } : undefined });
