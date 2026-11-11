import type { Button, TaskButtonAction } from "./types.js";

/** What a platform carries for a task button: the id comes back when it is pressed. */
export const buttonId = (button: Pick<Button, "taskId" | "action">): string => `t:${button.taskId}:${button.action}`;

export function parseButtonId(id: string | undefined): { taskId: string; action: TaskButtonAction } | undefined {
  const match = id?.match(/^t:([0-9a-f-]{36}):(approve|decline)$/);
  return match ? { taskId: match[1]!, action: match[2] as TaskButtonAction } : undefined;
}

/** Platforms cap a button's label; cut by code point so no emoji is split. */
export const fitLabel = (label: string, max: number): string => [...label].slice(0, max).join("");
