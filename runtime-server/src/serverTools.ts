import { requireTool } from "./tools.js";

type McpServerConfig = {
  url: string;
  headers?: Record<string, string>;
};

export class ServerToolExecutor {
  constructor(private readonly timeoutMs = 30_000) {}

  async execute(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = requireTool(name);
    if (tool.locality !== "server") {
      throw new Error(`Tool is not server-local: ${name}`);
    }

    const parsedArgs = tool.schema.parse(args) as Record<string, unknown>;

    if (name === "web.search") {
      return this.webSearch(parsedArgs);
    }

    if (name === "api.request") {
      return this.apiRequest(parsedArgs);
    }

    if (name === "mcp.call") {
      return this.mcpCall(parsedArgs);
    }

    throw new Error(`No server executor for tool: ${name}`);
  }

  private async webSearch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = String(args.query);
    const limit = Number(args.limit ?? 5);
    return {
      query,
      results: [
        {
          title: "Hatch runtime architecture",
          url: "https://example.invalid/hatch/runtime",
          snippet: "Server-side tools run on the runtime server; filesystem, shell, and git tools are brokered to the local client."
        },
        {
          title: "Brokered local tool execution",
          url: "https://example.invalid/hatch/local-tools",
          snippet: "The agent can request local tools, but the client validates permissions and executes them locally."
        }
      ].slice(0, Math.max(1, Math.min(limit, 10)))
    };
  }

  private async apiRequest(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {
      endpoint: args.endpoint,
      payload: args.payload ?? {},
      status: "ok"
    };
  }

  private async mcpCall(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const serverName = String(args.server);
    const toolName = String(args.tool);
    const config = configuredMcpServers()[serverName];
    if (!config) {
      throw new Error(`MCP server is not configured: ${serverName}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, this.timeoutMs));
    try {
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(config.headers ?? {})
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `hatch_${Date.now()}`,
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args.arguments ?? {}
          }
        }),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`MCP call failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
      }

      return {
        server: serverName,
        tool: toolName,
        status: response.status,
        response: parseJsonIfPossible(text)
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`MCP call timed out after ${Math.max(1, this.timeoutMs)}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function hasConfiguredMcpServers(): boolean {
  return Object.keys(configuredMcpServers()).length > 0;
}

function configuredMcpServers(): Record<string, McpServerConfig> {
  const raw = process.env.HATCH_MCP_SERVERS;
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("HATCH_MCP_SERVERS must be a JSON object");
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.url !== "string" || !record.url) continue;
    servers[name] = {
      url: record.url,
      headers: stringMap(record.headers)
    };
  }
  return servers;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function parseJsonIfPossible(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
