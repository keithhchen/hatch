import { requireTool } from "./tools.js";
import type { KnowledgeProvider } from "./agentCorpus.js";
import type { RuntimeCreatorTool } from "./creatorTools.js";
import { assertBoundedJsonValue, readBoundedJsonObject, readBoundedResponseText } from "./boundedResponse.js";

type McpServerConfig = {
  url: string;
  headers?: Record<string, string>;
};

type KnowledgeScope = {
  provider: KnowledgeProvider;
  creatorId: string;
  agentId: string;
  corpusDigest: string;
};

export class ServerToolExecutor {
  private knowledgeScope?: KnowledgeScope;
  private resolvedCreatorTools = new Map<string, RuntimeCreatorTool>();

  constructor(private readonly timeoutMs = 120000) {}

  setKnowledgeScope(scope: KnowledgeScope | undefined): void {
    this.knowledgeScope = scope;
  }

  setResolvedCreatorTools(tools: RuntimeCreatorTool[] = []): void {
    this.resolvedCreatorTools = new Map(tools.map((tool) => [tool.id, tool]));
  }

  async executeCreatorTool(
    tool: { id: string },
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const resolved = this.resolvedCreatorTools.get(tool.id);
    if (!resolved) throw new Error(`Creator tool is not resolved by the Registry Control Plane: ${tool.id}`);
    const result = await resolved.execute(args, boundedSignal(signal, this.timeoutMs));
    assertBoundedJsonValue(result);
    return result;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const tool = requireTool(name);
    if (tool.locality !== "server") {
      throw new Error(`Tool is not server-local: ${name}`);
    }

    const parsedArgs = tool.schema.parse(args) as Record<string, unknown>;
    const requestSignal = boundedSignal(signal, this.timeoutMs);

    if (name === "web.search" || name === "hatch.web_search") {
      const result = await this.webSearch(parsedArgs, requestSignal);
      assertBoundedJsonValue(result);
      return result;
    }

    if (name === "hatch.file_search") {
      const result = await this.fileSearch(parsedArgs, requestSignal);
      assertBoundedJsonValue(result);
      return result;
    }

    if (name === "api.request") {
      const result = await this.apiRequest(parsedArgs);
      assertBoundedJsonValue(result);
      return result;
    }

    if (name === "mcp.call") {
      const result = await this.mcpCall(parsedArgs, requestSignal);
      assertBoundedJsonValue(result);
      return result;
    }

    throw new Error(`No server executor for tool: ${name}`);
  }

  private async webSearch(args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const query = String(args.query);
    const limit = Number(args.limit ?? 5);
    const endpoint = process.env.HATCH_WEB_SEARCH_URL?.trim();
    const provider = process.env.HATCH_WEB_SEARCH_PROVIDER?.trim().toLowerCase();
    if (provider === "bocha" || process.env.HATCH_WEB_SEARCH_API_KEY?.trim()) {
      return this.bochaSearch(query, limit, endpoint, signal);
    }
    if (endpoint) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query, limit }),
        signal
      });
      if (!response.ok) throw new Error(`Hatch web search failed with HTTP ${response.status}`);
      const payload = await readBoundedJsonObject(response) as { results?: unknown };
      return { query, results: Array.isArray(payload.results) ? payload.results.slice(0, Math.max(1, Math.min(limit, 10))) : [] };
    }
    if (process.env.NODE_ENV === "production") {
      throw new Error("hatch.web_search is not configured (set HATCH_WEB_SEARCH_URL)");
    }
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

  private async bochaSearch(
    query: string,
    limit: number,
    configuredEndpoint: string | undefined,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    const apiKey = process.env.HATCH_WEB_SEARCH_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("hatch.web_search is not configured (set HATCH_WEB_SEARCH_API_KEY)");
    }
    const endpoint = (configuredEndpoint || "https://api.bocha.cn/v1/web-search").trim();
    const count = Math.max(1, Math.min(limit, 10));
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        query,
        freshness: "noLimit",
        summary: true,
        count
      }),
      signal
    });
    let payload: Record<string, unknown> = {};
    try {
      payload = await readBoundedJsonObject(response);
    } catch (error) {
      if (response.ok) throw error;
    }
    if (!response.ok) {
      const message = String(payload.msg ?? payload.message ?? "provider request failed");
      throw new Error(`Hatch web search failed with HTTP ${response.status}: ${message.slice(0, 300)}`);
    }
    const providerCode = payload.code;
    if (providerCode !== undefined && String(providerCode) !== "200") {
      const message = String(payload.msg ?? payload.message ?? "provider request failed");
      throw new Error(`Hatch web search failed with code ${providerCode}: ${message.slice(0, 300)}`);
    }
    const data = payload.data;
    const pages = data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).webPages
      : undefined;
    const values = pages && typeof pages === "object" && !Array.isArray(pages)
      ? (pages as Record<string, unknown>).value
      : undefined;
    const results = Array.isArray(values)
      ? values.slice(0, count).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))).map((item) => ({
          title: item.name,
          url: item.url,
          snippet: item.snippet,
          summary: item.summary,
          site_name: item.siteName,
          date_published: item.datePublished ?? item.dateLastCrawled
        }))
      : [];
    return { query, results };
  }

  private async fileSearch(args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.knowledgeScope) {
      throw new Error("hatch.file_search is unavailable because this Agent has no knowledge provider");
    }
    const hits = await this.knowledgeScope.provider.search({
      creatorId: this.knowledgeScope.creatorId,
      agentId: this.knowledgeScope.agentId,
      corpusDigest: this.knowledgeScope.corpusDigest,
      query: String(args.query),
      limit: Number(args.limit ?? 6),
      signal
    });
    return {
      query: String(args.query),
      hits: hits.map((hit) => ({ text: hit.text, score: hit.score }))
    };
  }

  private async apiRequest(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {
      endpoint: args.endpoint,
      payload: args.payload ?? {},
      status: "ok"
    };
  }

  private async mcpCall(args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const serverName = String(args.server);
    const toolName = String(args.tool);
    const config = configuredMcpServers()[serverName];
    if (!config) {
      throw new Error(`MCP server is not configured: ${serverName}`);
    }

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
      signal
    }).catch((error: unknown) => {
      if (signal.aborted
        && signal.reason instanceof Error
        && signal.reason.name !== "TimeoutError") {
        throw signal.reason;
      }
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || /timeout|aborted/i.test(error.message))) {
        throw new Error(`MCP call timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    });
    const text = await readBoundedResponseText(response);
    if (!response.ok) {
      throw new Error(`MCP call failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    return {
      server: serverName,
      tool: toolName,
      status: response.status,
      response: parseJsonIfPossible(text)
    };
  }
}

function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
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
