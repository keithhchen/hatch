import { z } from "zod";
import type { ClientToolName } from "./protocol.js";

export type ToolLocality = "server" | "client";
export type ToolApproval = "none" | "auto" | "ask";
export type ModelToolLocality = "server" | "client" | "hybrid";
export type ModelToolAvailability = "always" | "client_capability" | "mcp_configured" | "knowledge_configured";

export type ModelToolSpec = {
  name: string;
  runtimeName: string;
  clientTool?: ClientToolName;
  locality: ModelToolLocality;
  approval: ToolApproval;
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  availability: ModelToolAvailability;
};

export type ModelToolDispatch =
  | {
      target: "server";
      spec: ModelToolSpec;
      runtimeName: string;
      eventName: string;
      approval: ToolApproval;
    }
  | {
      target: "client";
      spec: ModelToolSpec;
      clientTool: ClientToolName;
      eventName: ClientToolName;
      approval: ToolApproval;
    }
  | {
      target: "hybrid";
      spec: ModelToolSpec;
      runtimeName: string;
      clientTool: ClientToolName;
      serverEventName: string;
      clientEventName: ClientToolName;
      approval: ToolApproval;
    };

export type ToolDefinition = {
  name: string;
  locality: ToolLocality;
  approval: ToolApproval;
  description: string;
  schema: z.ZodTypeAny;
  model?: {
    name: string;
    locality: ModelToolLocality;
    description?: string;
    properties: Record<string, unknown>;
    required: string[];
    availability?: ModelToolAvailability;
  };
};

export const toolRegistry = new Map<string, ToolDefinition>([
  ["hatch.web_search", {
    name: "hatch.web_search",
    locality: "server",
    approval: "none",
    description: "Hatch-provided public web search.",
    schema: z.object({ query: z.string(), limit: z.number().int().min(1).max(10).default(5) }).strict(),
    model: {
      name: "hatch_web_search",
      locality: "server",
      description: "Search the public web using Hatch's configured web-search provider.",
      properties: {
        query: stringSchema("Search query."),
        limit: numberSchema("Maximum number of results, from 1 to 10.")
      },
      required: ["query"],
      availability: "always"
    }
  }],
  ["hatch.file_search", {
    name: "hatch.file_search",
    locality: "server",
    approval: "none",
    description: "Search the current Creator Agent's retrieval-only knowledge space.",
    schema: z.object({ query: z.string(), limit: z.number().int().min(1).max(6).default(6) }).strict(),
    model: {
      name: "hatch_file_search",
      locality: "server",
      description: "Search the current Creator Agent knowledge space when the answer requires long-tail reference material.",
      properties: {
        query: stringSchema("Search query."),
        limit: numberSchema("Maximum number of knowledge hits, from 1 to 6.")
      },
      required: ["query"],
      availability: "knowledge_configured"
    }
  }],
  ["web.search", {
    name: "web.search",
    locality: "server",
    approval: "none",
    description: "Search public web or creator-owned API sources from the runtime server.",
    schema: z.object({ query: z.string(), limit: z.number().int().min(1).max(10).default(5) }).strict(),
    model: {
      name: "web_search",
      locality: "server",
      description: "Search public web or creator-owned public sources from the runtime server.",
      properties: {
        query: stringSchema("Search query."),
        limit: numberSchema("Maximum number of results, from 1 to 10.")
      },
      required: ["query"]
    }
  }],
  ["api.request", {
    name: "api.request",
    locality: "server",
    approval: "none",
    description: "Call a creator-owned server API.",
    schema: z.object({
      endpoint: z.string(),
      payload: z.record(z.string(), z.unknown()).default({})
    }).strict(),
    model: {
      name: "api_request",
      locality: "server",
      description: "Call a creator-owned server API. Use only when the task needs a configured server-side API.",
      properties: {
        endpoint: stringSchema("Server API endpoint or identifier."),
        payload: objectSchema("JSON payload for the server API.")
      },
      required: ["endpoint"]
    }
  }],
  ["mcp.call", {
    name: "mcp.call",
    locality: "server",
    approval: "none",
    description: "Call a server-configured MCP tool through the runtime server.",
    schema: z.object({
      server: z.string().min(1),
      tool: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()).default({})
    }).strict(),
    model: {
      name: "mcp_call",
      locality: "server",
      description: "Call a server-configured MCP tool. Use only when the task requires a configured server-side MCP integration.",
      properties: {
        server: stringSchema("Configured MCP server name."),
        tool: stringSchema("MCP tool name."),
        arguments: objectSchema("JSON arguments for the MCP tool.")
      },
      required: ["server", "tool"],
      availability: "mcp_configured"
    }
  }],
  ["skill.run", {
    name: "skill.run",
    locality: "server",
    approval: "none",
    description: "Run a server-owned protected skill in an isolated headless agent session.",
    schema: z.object({
      skill_id: z.string().min(1),
      task: z.string().min(1),
      context_refs: z.array(z.string()).default([])
    }).strict(),
    model: {
      name: "skill_run",
      locality: "server",
      description: "Run a matching protected server skill in an isolated headless worker. Pass the task and exact local/API context references needed by the skill.",
      properties: {
        skill_id: stringSchema("The public skill id from the server skill catalog."),
        task: stringSchema("The task for the protected skill worker."),
        context_refs: { type: "array", items: { type: "string" }, description: "References to user-provided local files or server context." }
      },
      required: ["skill_id", "task"]
    }
  }],
  ["fs.list", {
    name: "fs.list",
    locality: "client",
    approval: "auto",
    description: "List files inside the client-declared local workspace.",
    schema: z.object({ path: z.string().default(".") }).strict(),
    model: {
      name: "file_list",
      locality: "hybrid",
      description: "List a server-hosted skill resource directory by full path, or list files inside the client-declared local workspace when fs.list is enabled.",
      properties: {
        path: stringSchema("Full skill resource directory path or workspace-relative path to list.")
      },
      required: [],
      availability: "always"
    }
  }],
  ["fs.search", {
    name: "fs.search",
    locality: "client",
    approval: "auto",
    description: "Search files inside the client-declared local workspace.",
    schema: z.object({
      query: z.string(),
      path: z.string().default("."),
      max_results: z.number().int().min(1).max(100).default(20)
    }).strict(),
    model: {
      name: "file_search",
      locality: "client",
      description: "Search file paths and UTF-8 file contents inside the client-declared local workspace.",
      properties: {
        query: stringSchema("Literal search text."),
        path: stringSchema("Workspace-relative path to search."),
        max_results: numberSchema("Maximum number of matches.")
      },
      required: ["query"],
      availability: "client_capability"
    }
  }],
  ["fs.read", {
    name: "fs.read",
    locality: "client",
    approval: "auto",
    description: "Read a UTF-8 file inside the client-declared local workspace.",
    schema: z.object({ path: z.string() }).strict(),
    model: {
      name: "file_read",
      locality: "hybrid",
      description: "Read a UTF-8 file. Server-hosted skill bundle paths are read on the server; workspace paths are read by the local client when fs.read is enabled.",
      properties: {
        path: stringSchema("Full skill resource path or workspace-relative file path.")
      },
      required: ["path"],
      availability: "always"
    }
  }],
  ["fs.write", {
    name: "fs.write",
    locality: "client",
    approval: "auto",
    description: "Write a UTF-8 file inside the client-declared local workspace.",
    schema: z.object({ path: z.string(), content: z.string() }).strict(),
    model: {
      name: "file_write",
      locality: "client",
      description: "Write a UTF-8 file inside the client-declared local workspace.",
      properties: {
        path: stringSchema("Workspace-relative file path."),
        content: stringSchema("File content.")
      },
      required: ["path", "content"],
      availability: "client_capability"
    }
  }],
  ["fs.patch", {
    name: "fs.patch",
    locality: "client",
    approval: "auto",
    description: "Patch a UTF-8 file inside the client-declared local workspace.",
    schema: z.object({ path: z.string(), patch: z.string() }).strict(),
    model: {
      name: "file_patch",
      locality: "client",
      description: "Patch a UTF-8 file inside the client-declared local workspace using Hatch patch format.",
      properties: {
        path: stringSchema("Workspace-relative file path."),
        patch: stringSchema("Patch text.")
      },
      required: ["path", "patch"],
      availability: "client_capability"
    }
  }],
  ["shell.exec", {
    name: "shell.exec",
    locality: "client",
    approval: "auto",
    description: "Run a shell command on the user's machine inside the local workspace policy.",
    schema: z.object({
      command: z.string(),
      timeout_ms: z.number().int().min(100).max(120000).default(30000),
      justification: z.string().optional()
    }).strict(),
    model: {
      name: "shell_exec",
      locality: "client",
      description: "Run a shell command in the user's local workspace.",
      properties: {
        command: stringSchema("Shell command."),
        timeout_ms: numberSchema("Timeout in milliseconds."),
        justification: stringSchema("Operational reason for this command; omit when not needed.")
      },
      required: ["command"],
      availability: "client_capability"
    }
  }],
  ["git.diff", {
    name: "git.diff",
    locality: "client",
    approval: "auto",
    description: "Read git diff output from the client-declared workspace.",
    schema: z.object({ path: z.string().default(".") }).strict(),
    model: {
      name: "git_diff",
      locality: "client",
      description: "Read git diff output from the client-declared local workspace.",
      properties: {
        path: stringSchema("Workspace-relative path.")
      },
      required: [],
      availability: "client_capability"
    }
  }]
]);

export function requireTool(name: string): ToolDefinition {
  const tool = toolRegistry.get(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool;
}

export function modelToolSpecsForRun(
  clientTools: ClientToolName[],
  options: { hasMcpServers: boolean; hasKnowledge?: boolean }
): ModelToolSpec[] {
  return [...toolRegistry.values()]
    .flatMap((tool) => tool.model ? [toModelToolSpec(tool)] : [])
    .filter((spec) => modelToolAvailable(spec, clientTools, options));
}

export function requireModelTool(name: string): ModelToolSpec {
  const spec = [...toolRegistry.values()]
    .flatMap((tool) => tool.model ? [toModelToolSpec(tool)] : [])
    .find((tool) => tool.name === name);
  if (!spec) {
    throw new Error(`Unknown Pi tool: ${name}`);
  }
  return spec;
}

export function requireModelToolDispatch(name: string): ModelToolDispatch {
  const spec = requireModelTool(name);
  if (spec.locality === "server") {
    return {
      target: "server",
      spec,
      runtimeName: spec.runtimeName,
      eventName: spec.runtimeName,
      approval: spec.approval
    };
  }

  if (!spec.clientTool) {
    throw new Error(`Pi tool has no client runtime tool: ${spec.name}`);
  }

  if (spec.locality === "client") {
    return {
      target: "client",
      spec,
      clientTool: spec.clientTool,
      eventName: spec.clientTool,
      approval: spec.approval
    };
  }

  return {
    target: "hybrid",
    spec,
    runtimeName: spec.runtimeName,
    clientTool: spec.clientTool,
    serverEventName: spec.name,
    clientEventName: spec.clientTool,
    approval: spec.approval
  };
}

export function requireClientToolEnabled(clientTools: ClientToolName[], toolName: ClientToolName): void {
  if (!clientTools.includes(toolName)) {
    throw new Error(`Client tool is not enabled for this session: ${toolName}`);
  }
}

function toModelToolSpec(tool: ToolDefinition): ModelToolSpec {
  if (!tool.model) {
    throw new Error(`Tool has no model spec: ${tool.name}`);
  }
  return {
    name: tool.model.name,
    runtimeName: tool.name,
    ...(tool.locality === "client" ? { clientTool: tool.name as ClientToolName } : {}),
    locality: tool.model.locality,
    approval: tool.approval,
    description: tool.model.description ?? tool.description,
    properties: tool.model.properties,
    required: tool.model.required,
    availability: tool.model.availability ?? "always"
  };
}

function modelToolAvailable(
  spec: ModelToolSpec,
  clientTools: ClientToolName[],
  options: { hasMcpServers: boolean; hasKnowledge?: boolean }
): boolean {
  if (spec.availability === "mcp_configured") return options.hasMcpServers;
  if (spec.availability === "knowledge_configured") return Boolean(options.hasKnowledge);
  if (spec.availability === "client_capability") {
    return Boolean(spec.clientTool && clientTools.includes(spec.clientTool));
  }
  return true;
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function numberSchema(description: string): Record<string, unknown> {
  return { type: "number", description };
}

function objectSchema(description: string): Record<string, unknown> {
  return { type: "object", description, additionalProperties: true };
}
