import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";
import { AccountStoreTs, accountPublic, createAuthToken, verifyAuthToken, verifyPassword, type Account, type AccountRole } from "./registryAuth.js";
import { ControlPlaneError, RegistryStoreTs, type ToolConnection } from "./registryStore.js";

export type RegistryServer = { server: http.Server; close: () => Promise<void> };

export async function createRegistryServerFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<RegistryServer> {
  const store = await RegistryStoreTs.open({ environment });
  const accounts = new AccountStoreTs(store.databasePool());
  await accounts.ensureSchema();
  const publishToken = environment.HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN?.trim() || "";
  const authSecret = environment.HATCH_AUTH_SIGNING_SECRET?.trim() || "";
  const server = http.createServer((request, response) => {
    void route(request, response, { store, accounts, publishToken, authSecret }).catch((error) => {
      sendJson(response, 500, { detail: error instanceof Error ? error.message : String(error) });
    });
  });
  const port = Number(environment.REGISTRY_PORT ?? 8100);
  const host = environment.REGISTRY_HOST ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return { server, close: async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await store.close();
  } };
}

async function route(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: { store: RegistryStoreTs; accounts: AccountStoreTs; publishToken: string; authSecret: string },
): Promise<void> {
  if (request.method === "OPTIONS") { response.writeHead(204, corsHeaders()); response.end(); return; }
  const url = new URL(request.url ?? "/", "http://registry.local");
  if (request.method === "GET" && url.pathname === "/health") { sendJson(response, 200, { status: "ok" }); return; }

  if (url.pathname === "/v1/auth/signup" && request.method === "POST") {
    if (!context.authSecret) { sendJson(response, 503, { detail: "Account authentication is not configured." }); return; }
    try {
      const body = await readJson(request);
      const account = await context.accounts.create(String(body.email ?? ""), String(body.password ?? ""), body.role as AccountRole, String(body.display_name ?? ""));
      sendJson(response, 201, { token: createAuthToken(account, context.authSecret), account: accountPublic(account) });
    } catch (error) { sendError(response, error, { email_already_registered: [409, "Email is already registered."] }); }
    return;
  }
  if (url.pathname === "/v1/auth/signin" && request.method === "POST") {
    if (!context.authSecret) { sendJson(response, 503, { detail: "Account authentication is not configured." }); return; }
    const body = await readJson(request);
    const account = await context.accounts.getByEmail(String(body.email ?? ""));
    if (!account || !verifyPassword(String(body.password ?? ""), account)) { sendJson(response, 401, { detail: "Email or password is incorrect." }); return; }
    sendJson(response, 200, { token: createAuthToken(account, context.authSecret), account: accountPublic(account) });
    return;
  }
  if (url.pathname === "/v1/auth/me" && request.method === "GET") {
    const account = await authenticate(request, context.accounts, context.authSecret);
    if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
    sendJson(response, 200, accountPublic(account));
    return;
  }

  if (url.pathname === "/v1/catalog/agents" && request.method === "GET") {
    sendJson(response, 200, await context.store.listAllAgentCorpora());
    return;
  }
  if (url.pathname === "/v1/creator/agents" && request.method === "GET") {
    const account = await authenticate(request, context.accounts, context.authSecret, "creator");
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
    sendJson(response, 200, await context.store.listAgentCorpora(account.id));
    return;
  }
  if (url.pathname === "/v1/user/agent-access" && request.method === "GET") {
    const account = await authenticate(request, context.accounts, context.authSecret, "user");
    if (!account) { sendJson(response, 401, { detail: "A valid user account token is required." }); return; }
    sendJson(response, 200, context.store.listAgentAccess(account.id));
    return;
  }
  const accessMatch = url.pathname.match(/^\/v1\/user\/agents\/([^/]+)\/([^/]+)\/access$/);
  if (accessMatch && request.method === "POST") {
    const account = await authenticate(request, context.accounts, context.authSecret, "user");
    if (!account) { sendJson(response, 401, { detail: "A valid user account token is required." }); return; }
    try { sendJson(response, 201, await context.store.grantAgentAccess(account.id, decodeURIComponent(accessMatch[1]!), decodeURIComponent(accessMatch[2]!))); }
    catch (error) { sendError(response, error, { agent_not_found: [404, "Agent not found."] }); }
    return;
  }

  if (url.pathname === "/v1/agent-corpora" && request.method === "POST") {
    if (!context.publishToken || bearer(request) !== context.publishToken) { sendJson(response, 403, { detail: "A valid Registry publish token is required." }); return; }
    const creatorId = url.searchParams.get("creator_id") ?? "";
    const agentId = url.searchParams.get("agent_id") ?? "";
    try { sendJson(response, 201, await context.store.publishAgentCorpusBundle(creatorId, agentId, await readBytes(request))); }
    catch (error) { sendError(response, error, { agent_not_found: [404, "Agent not found."] }); }
    return;
  }
  if (url.pathname === "/v1/creator/agent-corpora" && request.method === "POST") {
    const account = await authenticate(request, context.accounts, context.authSecret, "creator");
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
    const agentId = url.searchParams.get("agent_id") ?? "";
    try { sendJson(response, 201, await context.store.publishAgentCorpusBundle(account.id, agentId, await readBytes(request))); }
    catch (error) { sendError(response, error); }
    return;
  }
  const corpusMatch = url.pathname.match(/^\/v1\/agent-corpora\/([^/]+)(?:\/([^/]+))?$/);
  if (corpusMatch && request.method === "GET") {
    const creatorId = decodeURIComponent(corpusMatch[1]!);
    if (corpusMatch[2]) {
      const corpus = context.store.getAgentCorpus(creatorId, decodeURIComponent(corpusMatch[2]!));
      if (!corpus) { sendJson(response, 404, { detail: "Agent Corpus not found." }); return; }
      sendJson(response, 200, corpus);
    } else sendJson(response, 200, await context.store.listAgentCorpora(creatorId));
    return;
  }

  const connectionMatch = url.pathname.match(/^\/v1\/control-plane\/connections\/([^/]+)$/);
  if (connectionMatch && request.method === "PUT") {
    const creatorId = creatorScope(request, response, context.publishToken);
    if (!creatorId) return;
    try {
      const body = await readJson(request);
      const kind = body.kind;
      if (kind !== "http" && kind !== "mcp") throw new Error("connection kind must be http or mcp");
      const connection = await context.store.upsertConnection({
        creatorId,
        connectionId: decodeURIComponent(connectionMatch[1]!),
        kind,
        secretRef: body.secret_ref === undefined || body.secret_ref === null ? null : String(body.secret_ref),
        config: (body.config ?? {}) as Record<string, unknown>,
        status: body.status === "disabled" ? "disabled" : "active",
      });
      sendJson(response, 200, connectionPayload(connection));
    } catch (error) { sendError(response, error); }
    return;
  }
  const bindMatch = url.pathname.match(/^\/v1\/creators\/([^/]+)\/agents\/([^/]+)\/tools\/([^/]+)$/);
  if (bindMatch && request.method === "PUT") {
    const creatorId = creatorScope(request, response, context.publishToken);
    if (!creatorId) return;
    const pathCreatorId = decodeURIComponent(bindMatch[1]!);
    if (creatorId !== pathCreatorId) { sendJson(response, 403, { detail: "creator path does not match authenticated creator" }); return; }
    try {
      const body = await readJson(request);
      await context.store.bindAgentTool({
        creatorId,
        agentId: decodeURIComponent(bindMatch[2]!),
        toolId: decodeURIComponent(bindMatch[3]!),
        connectionId: String(body.connection_id ?? ""),
      });
      sendJson(response, 204, undefined);
    } catch (error) { sendError(response, error); }
    return;
  }
  const resolveMatch = url.pathname.match(/^\/v1\/runtime\/creators\/([^/]+)\/agents\/([^/]+)\/tools\/([^/]+)$/);
  if (resolveMatch && request.method === "GET") {
    const creatorId = creatorScope(request, response, context.publishToken);
    if (!creatorId) return;
    const pathCreatorId = decodeURIComponent(resolveMatch[1]!);
    if (creatorId !== pathCreatorId) { sendJson(response, 403, { detail: "creator path does not match authenticated creator" }); return; }
    try {
      const connection = await context.store.resolveAgentToolConnection(creatorId, decodeURIComponent(resolveMatch[2]!), decodeURIComponent(resolveMatch[3]!));
      sendJson(response, 200, connectionPayload(connection));
    } catch (error) {
      if (error instanceof ControlPlaneError) { sendJson(response, 404, { detail: error.message }); return; }
      sendError(response, error);
    }
    return;
  }
  sendJson(response, 404, { detail: "Route not found." });
}

function creatorScope(request: http.IncomingMessage, response: http.ServerResponse, publishToken: string): string | undefined {
  if (!publishToken || bearer(request) !== publishToken) {
    sendJson(response, 403, { detail: "A valid Registry publish token is required." });
    return undefined;
  }
  const creatorId = request.headers["x-hatch-creator-id"];
  if (typeof creatorId !== "string" || !creatorId.trim()) {
    sendJson(response, 400, { detail: "X-Hatch-Creator-Id is required." });
    return undefined;
  }
  return creatorId.trim();
}

function connectionPayload(connection: ToolConnection): Record<string, unknown> {
  return { id: connection.id, creator_id: connection.creator_id, kind: connection.kind, secret_ref: connection.secret_ref, config: connection.config, status: connection.status };
}

async function authenticate(request: http.IncomingMessage, accounts: AccountStoreTs, secret: string, role?: AccountRole): Promise<Account | undefined> {
  const claims = verifyAuthToken(bearer(request), secret);
  if (!claims || (role && claims.role !== role)) return undefined;
  return accounts.getById(claims.sub);
}

function bearer(request: http.IncomingMessage): string | undefined {
  const value = request.headers.authorization ?? "";
  const [scheme, token] = value.split(" ", 2);
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

async function readBytes(request: http.IncomingMessage, max = 64 * 1024 * 1024): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > max) throw new Error("Request body is too large");
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const payload = JSON.parse(Buffer.from(await readBytes(request, 1024 * 1024)).toString("utf8")) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("JSON body must be an object");
  return payload as Record<string, unknown>;
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
function sendError(response: http.ServerResponse, error: unknown, known: Record<string, [number, string]> = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  const [status, detail] = known[message] ?? (error instanceof Error && error.name === "AgentCorpusVerificationError" ? [422, message] : [422, message]);
  sendJson(response, status, { detail });
}
function corsHeaders(): Record<string, string> { return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "access-control-allow-headers": "authorization,content-type,x-hatch-creator-id" }; }

if (import.meta.url === `file://${process.argv[1]}`) {
  createRegistryServerFromEnvironment().then(({ server }) => {
    console.log(`Hatch TypeScript Registry listening on ${JSON.stringify(server.address())}`);
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
