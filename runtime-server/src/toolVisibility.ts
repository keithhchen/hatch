export function projectToolResultForVisibility(
  scope: "main" | "skill_run" | undefined,
  name: string,
  result: Record<string, unknown>
): Record<string, unknown> {
  if (scope !== "skill_run") return result;
  return {
    redacted: true,
    reason: "protected_skill_tool_result",
    tool: name
  };
}

export function projectToolArgumentsForVisibility(
  scope: "main" | "skill_run" | undefined,
  name: string,
  argumentsValue: Record<string, unknown>
): Record<string, unknown> {
  if (scope !== "skill_run") return argumentsValue;
  return {
    redacted: true,
    reason: "protected_skill_tool_arguments",
    tool: name
  };
}
