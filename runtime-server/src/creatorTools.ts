import type { AgentCorpus, CreatorCorpusTool } from "./agentCorpus.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";

export type CreatorToolFunction = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/**
 * A resolved tool exists only in Runtime memory. `connection_ref` is resolved
 * by the Control Plane; neither the Corpus nor the model ever sees a URL or a
 * credential.
 */
export type RuntimeCreatorTool = {
  id: string;
  modelName: string;
  kind: "http" | "mcp";
  connectionRef: string;
  function: CreatorToolFunction;
  execute: (arguments_: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

export type CreatorToolResolutionRequest = {
  tenantId: string;
  agentId: string;
  tool: CreatorCorpusTool;
};

/**
 * Runtime depends on this narrow interface rather than a concrete secret or
 * database implementation. The production Control Plane owns connection
 * metadata, secret references, OAuth grants, and the actual invocation.
 */
export interface CreatorToolControlPlane {
  resolve(request: CreatorToolResolutionRequest): Promise<RuntimeCreatorTool[]>;
}

export async function resolveCreatorTools(
  controlPlane: CreatorToolControlPlane | undefined,
  tenantId: string,
  agentId: string,
  corpus: AgentCorpus
): Promise<RuntimeCreatorTool[]> {
  const declared = corpus.tools.filter((tool): tool is CreatorToolResolutionRequest["tool"] => tool.kind === "http_function" || tool.kind === "mcp_tool");
  if (declared.length === 0) return [];
  if (!controlPlane) {
    throw new Error("Creator tool bindings are unavailable: configure the Hatch Control Plane before loading this Agent.");
  }
  const resolved = (await Promise.all(declared.map((tool) => controlPlane.resolve({ tenantId, agentId, tool })))).flat();
  const modelNames = new Set<string>();
  for (const tool of resolved) {
    if (!tool.id.startsWith("creator.")) throw new Error(`Control Plane returned an invalid Creator tool id: ${tool.id}`);
    if (!tool.modelName.startsWith("creator_")) throw new Error(`Control Plane returned an invalid model function name: ${tool.modelName}`);
    if (modelNames.has(tool.modelName)) throw new Error(`Control Plane resolved duplicate model tool name: ${tool.modelName}`);
    modelNames.add(tool.modelName);
  }
  return resolved;
}

/** OpenAI-compatible function names cannot contain dots; the public id keeps them. */
export function creatorModelToolName(toolId: string): string {
  return `creator_${toolId.replace(/^creator\./, "").replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function emptyObjectSchema(): Record<string, unknown> {
  return { type: "object", properties: {}, required: [], additionalProperties: false };
}

const ConnectionSchema = z.object({
  id: z.string().min(1),
  tenant_id: z.string().min(1),
  kind: z.enum(["http", "mcp"]),
  secret_ref: z.string().min(1).nullable(),
  config: z.object({
    url: z.string().url(),
    // Creator HTTP tools default to POST for backwards compatibility. GET is
    // needed by already-packaged Creator APIs such as Seth Alpha Lite.
    method: z.enum(["GET", "POST"]).default("POST"),
    headers: z.record(z.string(), z.string()).optional(),
    auth: z.object({
      header: z.string().min(1).default("Authorization"),
      prefix: z.string().default("Bearer ")
    }).strict().optional()
  }).passthrough(),
  status: z.literal("active")
}).strict();

type ResolvedConnection = z.infer<typeof ConnectionSchema>;

export interface SecretResolver {
  resolve(secretRef: string): Promise<string | undefined>;
}

/** Production secret references are resolved by the Runtime host, never Registry. */
export class EnvironmentSecretResolver implements SecretResolver {
  async resolve(secretRef: string): Promise<string | undefined> {
    const match = secretRef.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!match) throw new Error(`Unsupported Secret Manager reference: ${secretRef}`);
    const value = process.env[match[1]!]?.trim();
    if (!value) throw new Error(`Runtime secret is unavailable: ${secretRef}`);
    return value;
  }
}

export function creatorToolControlPlaneFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): RegistryCreatorToolControlPlane | undefined {
  const registryUrl = environment.HATCH_REGISTRY_URL?.trim();
  const serviceToken = environment.HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN?.trim();
  if (!registryUrl && !serviceToken) return undefined;
  if (!registryUrl || !serviceToken) {
    throw new Error("HATCH_REGISTRY_URL and HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN must be configured together for Creator tools");
  }
  return new RegistryCreatorToolControlPlane({ registryUrl, serviceToken });
}

/**
 * Internal Registry client. It materializes creator tools server-side only;
 * the Desktop, model prompt, and Agent Corpus never receive connection data.
 */
export class RegistryCreatorToolControlPlane implements CreatorToolControlPlane {
  constructor(
    private readonly options: {
      registryUrl: string;
      serviceToken: string;
      secretResolver?: SecretResolver;
      timeoutMs?: number;
    }
  ) {}

  async resolve(request: CreatorToolResolutionRequest): Promise<RuntimeCreatorTool[]> {
    const connection = await this.connectionFor(request);
    const headers = await requestHeaders(connection, this.options.secretResolver ?? new EnvironmentSecretResolver());
    const declared = request.tool;
    if (declared.kind === "http_function") {
      return [{
        id: declared.id,
        modelName: creatorModelToolName(declared.id),
        kind: "http",
        connectionRef: declared.connection_ref,
        function: {
          name: declared.operation,
          description: declared.description ?? `Call ${declared.operation} through the Creator's configured HTTP connection.`,
          parameters: declared.input_schema ?? emptyObjectSchema()
        },
        execute: async (arguments_) => httpJsonCall(connection.config.url, headers, arguments_, this.options.timeoutMs, connection.config.method)
      }];
    }
    // One initialized MCP session is shared by every allowed operation for this
    // Creator tool binding. The Corpus remains transport-agnostic: it only
    // declares the connection reference and the allowed operation names.
    const client = new StreamableHttpMcpClient(connection.config.url, headers, this.options.timeoutMs);
    const remoteTools = await client.listTools();
    const remote = remoteTools.find((tool) => tool.name === declared.tool_name);
    if (!remote) {
      throw new Error(`MCP connection ${connection.id} does not expose declared Agent operation: ${declared.tool_name}`);
    }
    return [{
      id: declared.id,
      modelName: creatorModelToolName(declared.id),
      kind: "mcp" as const,
      connectionRef: declared.connection_ref,
      function: {
        name: remote.name,
        description: declared.description ?? remote.description ?? `Call ${remote.name} through the Creator's configured MCP connection.`,
        parameters: declared.input_schema ?? mcpInputSchema(remote.inputSchema)
      },
      execute: async (arguments_) => client.callTool(remote.name, arguments_)
    }];
  }

  private async connectionFor(request: CreatorToolResolutionRequest): Promise<ResolvedConnection> {
    const base = this.options.registryUrl.replace(/\/$/, "");
    const response = await fetch(`${base}/v1/runtime/tenants/${encodeURIComponent(request.tenantId)}/agents/${encodeURIComponent(request.agentId)}/tools/${encodeURIComponent(request.tool.id)}`, {
      headers: {
        authorization: `Bearer ${this.options.serviceToken}`,
        "x-hatch-tenant-id": request.tenantId,
        accept: "application/json"
      },
      signal: timeoutSignal(this.options.timeoutMs)
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Control Plane could not resolve ${request.tool.id}: HTTP ${response.status}`);
    const connection = ConnectionSchema.parse(JSON.parse(body));
    const expectedKind = request.tool.kind === "http_function" ? "http" : "mcp";
    if (connection.tenant_id !== request.tenantId || connection.kind !== expectedKind || connection.id !== request.tool.connection_ref) {
      throw new Error(`Control Plane binding does not match declared Creator tool ${request.tool.id}`);
    }
    return connection;
  }
}

async function requestHeaders(connection: ResolvedConnection, resolver: SecretResolver): Promise<Record<string, string>> {
  const headers = { ...(connection.config.headers ?? {}) };
  if (!connection.secret_ref) return headers;
  const secret = await resolver.resolve(connection.secret_ref);
  if (!secret) throw new Error(`Control Plane secret is unavailable for connection ${connection.id}`);
  const auth = connection.config.auth ?? { header: "Authorization", prefix: "Bearer " };
  headers[auth.header] = `${auth.prefix}${secret}`;
  return headers;
}

async function httpJsonCall(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  timeoutMs?: number,
  method: "GET" | "POST" = "POST"
): Promise<Record<string, unknown>> {
  const requestUrl = new URL(url);
  const requestHeaders: Record<string, string> = { accept: "application/json", ...headers };
  const request: RequestInit = {
    method,
    headers: requestHeaders,
    signal: timeoutSignal(timeoutMs)
  };
  if (method === "GET") {
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined || value === null) continue;
      const serialized = typeof value === "object" ? JSON.stringify(value) : String(value);
      requestUrl.searchParams.set(key, serialized);
    }
  } else {
    requestHeaders["content-type"] = "application/json";
    request.body = JSON.stringify(payload);
  }
  const response = await fetch(requestUrl, request);
  const body = await response.text();
  if (!response.ok) throw new Error(`Creator HTTP tool failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
  const value = parseObject(body, "Creator HTTP tool returned a non-object response");
  return value;
}

type McpRemoteTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

/**
 * A small, standards-aligned Streamable HTTP client for Creator MCP tools.
 *
 * MCP 2025-11-25 requires initialization before normal requests, permits a
 * server-issued `MCP-Session-Id`, and requires the negotiated protocol header
 * on subsequent messages. Several production servers respond with an SSE
 * envelope even for a request/response exchange, so both JSON and SSE are
 * accepted here.
 */
class StreamableHttpMcpClient {
  private readonly protocolVersion = "2025-11-25";
  private sessionId: string | undefined;
  private initialization: Promise<void> | undefined;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly timeoutMs?: number,
  ) {}

  async listTools(): Promise<McpRemoteTool[]> {
    const response = await this.request("tools/list", {});
    const tools = (response.result as Record<string, unknown> | undefined)?.tools;
    if (!Array.isArray(tools)) throw new Error("MCP tools/list returned no tools array");
    return tools.map((tool) => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool) || typeof (tool as Record<string, unknown>).name !== "string") {
        throw new Error("MCP tools/list returned an invalid tool definition");
      }
      const value = tool as Record<string, unknown>;
      return {
        name: value.name as string,
        ...(typeof value.description === "string" ? { description: value.description } : {}),
        ...(value.inputSchema && typeof value.inputSchema === "object" && !Array.isArray(value.inputSchema) ? { inputSchema: value.inputSchema as Record<string, unknown> } : {})
      };
    });
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.request("tools/call", { name, arguments: arguments_ });
    const result = response.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Creator MCP tools/call returned no result object");
    }
    // Return the MCP CallToolResult, never the transport JSON-RPC envelope, to
    // the model. This preserves `content` and `isError` semantics intact.
    return result as Record<string, unknown>;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.initialize();
    return this.post(method, params, true);
  }

  private async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.doInitialize();
    }
    return this.initialization;
  }

  private async doInitialize(): Promise<void> {
    const initialized = await this.post("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "hatch-runtime", version: "0.1.0" },
    }, false);
    const result = initialized.result as Record<string, unknown> | undefined;
    const negotiated = typeof result?.protocolVersion === "string" ? result.protocolVersion : this.protocolVersion;
    if (negotiated !== this.protocolVersion) {
      throw new Error(`Creator MCP server negotiated an unsupported protocol version: ${negotiated}`);
    }
    // This notification is intentionally best-effort: a server may return 202
    // with an empty body for notifications, which is compliant Streamable HTTP.
    await this.post("notifications/initialized", {}, true, true);
  }

  private async post(method: string, params: Record<string, unknown>, initialized: boolean, notification = false): Promise<Record<string, unknown>> {
    const requestHeaders: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (initialized) requestHeaders["MCP-Protocol-Version"] = this.protocolVersion;
    if (this.sessionId) requestHeaders["MCP-Session-Id"] = this.sessionId;
    const body = notification
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: `hatch_${randomUUID()}`, method, params };
    const response = await fetch(this.url, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal: timeoutSignal(this.timeoutMs),
    });
    const session = response.headers.get("MCP-Session-Id");
    if (session) this.sessionId = session;
    const responseBody = await response.text();
    if (!response.ok) throw new Error(`Creator MCP tool failed with HTTP ${response.status}: ${responseBody.slice(0, 500)}`);
    if (notification && !responseBody.trim()) return {};
    const value = parseMcpResponse(responseBody);
    if (value.error) throw new Error(`Creator MCP tool returned an error: ${JSON.stringify(value.error).slice(0, 500)}`);
    return value;
  }
}

function parseMcpResponse(body: string): Record<string, unknown> {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Creator MCP tool returned an empty response");
  if (!trimmed.split(/\r?\n/).some((line) => line.startsWith("data:"))) {
    return parseObject(trimmed, "Creator MCP tool returned a non-object response");
  }
  // Streamable HTTP responses may contain SSE comments and multiple events.
  // The last JSON-RPC data frame is the response for this request.
  const data = trimmed.split(/\r?\n\r?\n/)
    .map((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n"))
    .filter(Boolean)
    .at(-1);
  if (!data) throw new Error("Creator MCP tool returned no SSE data frame");
  return parseObject(data, "Creator MCP tool returned an invalid SSE response");
}

function mcpInputSchema(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value || value.type !== "object" || !value.properties || typeof value.properties !== "object" || Array.isArray(value.properties)) {
    return { type: "object", properties: {}, required: [], additionalProperties: false };
  }
  return {
    ...value,
    required: Array.isArray(value.required) ? value.required : [],
    additionalProperties: value.additionalProperties === undefined ? false : value.additionalProperties
  };
}

function parseObject(body: string, error: string): Record<string, unknown> {
  const value = JSON.parse(body) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function timeoutSignal(timeoutMs = 30_000): AbortSignal {
  return AbortSignal.timeout(Math.max(1, timeoutMs));
}
