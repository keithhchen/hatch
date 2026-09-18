import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { result } from "./files.js";
import { fileTools } from "./tools.js";
import { webTools } from "./web.js";
import { WorkbenchStore } from "./store.js";

export type FactoryToolDefinition = { role: string; tools: string[] };

/** Shared source of truth for the tools exposed to text and Gemini Live Agents. */
export async function factoryAgentTools(options: {
  store: WorkbenchStore;
  id: string;
  definition: FactoryToolDefinition;
  signal: AbortSignal;
  changed: () => void;
  todosChanged?: () => void;
  env?: NodeJS.ProcessEnv;
  extraTools?: AgentTool[] | Promise<AgentTool[]>;
}): Promise<AgentTool[]> {
  const candidates = [
    ...(options.definition.role === "voice" ? [] : [createAskUserTool()]),
    createTodoTool(options.store, options.id, options.todosChanged ?? options.changed),
    ...fileTools(options.store, options.id, { changed: options.changed }),
    ...webTools(options.store, options.id, options.changed, options.env),
    ...(await options.extraTools ?? []),
  ];
  // askuser is a host capability for text Factory Agents only. Voice uses a
  // continuous conversation and must not receive a blocking structured prompt.
  // The definition-specific list still controls the business tools.
  return candidates.filter(tool => options.definition.tools.includes(tool.name) || (tool.name === "askuser" && options.definition.role !== "voice"));
}

const askUserOption = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 240 }),
});

const askUserQuestion = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  header: Type.Optional(Type.String({ maxLength: 40 })),
  question: Type.String({ minLength: 1, maxLength: 1000 }),
  options: Type.Array(askUserOption, { maxItems: 8 }),
  multiSelect: Type.Optional(Type.Boolean()),
  required: Type.Optional(Type.Boolean()),
});

/**
 * Ask the Creator for one batch of answers and end the current Agent turn.
 * The next ordinary user message is the continuation. This is intentionally
 * not a waiting Promise or a second execution state.
 */
export function createAskUserTool(): AgentTool {
  return {
    name: "askuser",
    label: "询问用户",
    description: "Ask the Creator for information or a decision that materially affects the work. Put related questions into one questions array. When useful, provide options as objects with one single-line content field; the interface always also provides a free-form answer field. Do not ask for routine confirmation or facts already available in the inputs.",
    parameters: Type.Object({ questions: Type.Array(askUserQuestion, { minItems: 1, maxItems: 8 }) }),
    execute: async (_callId, raw) => {
      const input = raw as { questions: Array<{
        id?: string;
        header?: string;
        question: string;
        options: Array<{ content: string }>;
        multiSelect?: boolean;
        required?: boolean;
      }> };
      const seen = new Set<string>();
      const questions = input.questions.map((question, index) => {
        const id = question.id?.trim() || `question-${index + 1}`;
        if (seen.has(id)) throw new Error(`askuser question ids must be unique: ${id}`);
        seen.add(id);
        return {
          id,
          ...(question.header?.trim() ? { header: question.header.trim() } : {}),
          question: question.question.trim(),
          options: question.options.map((option, optionIndex) => ({
            id: `option-${optionIndex + 1}`,
            content: option.content.trim(),
          })),
          multiSelect: question.multiSelect === true,
          required: question.required !== false,
        };
      });
      return {
        content: [{ type: "text" as const, text: "The user must answer the askuser block before you continue. End this turn now." }],
        details: { type: "askuser", questions },
        terminate: true,
      };
    },
  };
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
