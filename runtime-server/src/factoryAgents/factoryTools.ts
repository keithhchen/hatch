import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { result } from "./files.js";
import { fileTools } from "./tools.js";
import { webTools } from "./web.js";
import { WorkbenchStore } from "./store.js";

export type FactoryToolDefinition = { tools: string[] };

/** Shared source of truth for the tools exposed to text and Gemini Live Agents. */
export async function factoryAgentTools(options: {
  store: WorkbenchStore;
  id: string;
  definition: FactoryToolDefinition;
  signal: AbortSignal;
  changed: () => void;
  env?: NodeJS.ProcessEnv;
  extraTools?: AgentTool[] | Promise<AgentTool[]>;
}): Promise<AgentTool[]> {
  const candidates = [
    createTodoTool(options.store, options.id, options.changed),
    ...fileTools(options.store, options.id, { changed: options.changed }),
    ...webTools(options.store, options.id, options.changed, options.env),
    ...(await options.extraTools ?? []),
  ];
  return candidates.filter(tool => options.definition.tools.includes(tool.name));
}

export function createTodoTool(store: WorkbenchStore, id: string, changed: () => void): AgentTool {
  const item = Type.Object({
    title: Type.String({ minLength: 1, maxLength: 160 }),
    status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
  });
  return {
    name: "update_todo",
    label: "更新待办",
    description: "Read or replace this Agent's short current todo list. Omit todos to read it; pass the complete list to replace it; pass [] to clear it. Use only for meaningful multi-step work. Keep at most one item in_progress and update it when work actually moves.",
    parameters: Type.Object({ todos: Type.Optional(Type.Array(item, { maxItems: 12 })) }),
    execute: async (_callId, raw) => {
      const { todos } = raw as { todos?: Array<{ title: string; status: "pending" | "in_progress" | "completed" }> };
      if (todos === undefined) return result({ todos: (await store.get(id)).todos });
      if (todos.filter(todo => todo.status === "in_progress").length > 1) throw new Error("Only one todo may be in_progress");
      if (todos.some(todo => !todo.title.trim())) throw new Error("Todo titles must not be empty");
      await store.update(id, session => {
        session.todos = todos.map(todo => ({ ...todo, title: todo.title.trim() }));
      });
      changed();
      return result({ todos: (await store.get(id)).todos, saved: true });
    },
  };
}
