import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";
import { AccountStoreTs, accountPublic, verifyAuthToken, verifyPassword, type Account, type AccountRole } from "./registryAuth.js";
import { RegistryStoreTs } from "./registryStore.js";

export type RegistryServer = { server: http.Server; close: () => Promise<void> };

export async function createRegistryServerFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<RegistryServer> {
  const store = await RegistryStoreTs.open({ environment });
  const accounts = new AccountStoreTs(store.databasePool());
  await accounts.ensureSchema();
  const publishToken = environment.HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN?.trim() || "";
  const runtimeServiceToken = environment.HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN?.trim() || "";
  const authSecret = environment.HATCH_AUTH_SIGNING_SECRET?.trim() || "";
  const server = http.createServer((request, response) => {
    void route(request, response, { store, accounts, publishToken, runtimeServiceToken, authSecret }).catch((error) => {
      sendJson(response, errorStatus(error), { detail: error instanceof Error ? error.message : String(error) });
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
  context: { store: RegistryStoreTs; accounts: AccountStoreTs; publishToken: string; runtimeServiceToken: string; authSecret: string },
): Promise<void> {
  if (request.method === "OPTIONS") { response.writeHead(204, corsHeaders()); response.end(); return; }
  const url = new URL(request.url ?? "/", "http://registry.local");
  if (request.method === "GET" && url.pathname === "/health") { sendJson(response, 200, { status: "ok" }); return; }

  if (url.pathname === "/v1/auth/signup" && request.method === "POST") {
    try {
      const body = await readJson(request);
      const account = await context.accounts.create(String(body.email ?? ""), String(body.password ?? ""), body.role as AccountRole, String(body.display_name ?? ""));
      sendJson(response, 201, sessionResponse(account, await context.accounts.createSession(account)));
    } catch (error) { sendError(response, error, { email_already_registered: [409, "Email is already registered."] }); }
    return;
  }
  if (url.pathname === "/v1/auth/signin" && request.method === "POST") {
    const body = await readJson(request);
    const account = await context.accounts.getByEmail(String(body.email ?? ""));
    if (!account || !verifyPassword(String(body.password ?? ""), account)) { sendJson(response, 401, { detail: "Email or password is incorrect." }); return; }
    sendJson(response, 200, sessionResponse(account, await context.accounts.createSession(account)));
    return;
  }
  if (url.pathname === "/v1/auth/me" && request.method === "GET") {
    const token = bearer(request);
    const session = await context.accounts.resolveSession(token);
    if (session) {
      sendJson(response, 200, { ...accountPublic(session.account), session_expires_at: session.session.absolute_expires_at });
      return;
    }
    const account = await authenticateLegacy(token, context.accounts, context.authSecret);
    if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
    sendJson(response, 200, accountPublic(account));
    return;
  }
  if (url.pathname === "/v1/auth/logout" && request.method === "POST") {
    await context.accounts.revokeSession(bearer(request));
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }

  if (url.pathname === "/v1/catalog/agents" && request.method === "GET") {
    sendJson(response, 200, await context.store.listAllAgentCorpora());
    return;
  }

  const connectionMatch = url.pathname.match(/^\/v1\/control-plane\/connections\/([^/]+)$/);
  if (connectionMatch && request.method === "PUT") {
    requireRuntimeServiceAuth(request, context.runtimeServiceToken);
    const tenantId = request.headers["x-hatch-tenant-id"]?.toString() ?? "";
    const body = await readJson(request);
    try {
      const connection = await context.store.upsertCreatorToolConnection({
        tenantId,
        connectionId: decodeURIComponent(connectionMatch[1]!),
        kind: body.kind === "mcp" ? "mcp" : "http",
        secretRef: body.secret_ref === null || body.secret_ref === undefined ? null : String(body.secret_ref),
        secret: body.secret === null || body.secret === undefined ? null : String(body.secret),
        config: body.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config as Record<string, unknown> : {},
        status: body.status === "disabled" ? "disabled" : "active"
      });
      sendJson(response, 200, { id: connection.id, creator_id: connection.tenant_id, kind: connection.kind, secret_ref: connection.secret_ref, secret: connection.secret, config: connection.config, status: connection.status });
    } catch (error) {
      sendJson(response, 422, { detail: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const bindingMatch = url.pathname.match(/^\/v1\/creators\/([^/]+)\/agents\/([^/]+)\/tools\/([^/]+)$/);
  if (bindingMatch && request.method === "PUT") {
    requireRuntimeServiceAuth(request, context.runtimeServiceToken);
    const creatorId = decodeURIComponent(bindingMatch[1]!);
    if (request.headers["x-hatch-creator-id"]?.toString() !== creatorId) {
      sendJson(response, 403, { detail: "creator path does not match authenticated creator" });
      return;
    }
    const body = await readJson(request);
    try {
      await context.store.bindCreatorTool({
        tenantId: creatorId,
        agentId: decodeURIComponent(bindingMatch[2]!),
        toolId: decodeURIComponent(bindingMatch[3]!),
        connectionId: String(body.connection_id ?? "")
      });
      response.writeHead(204, corsHeaders());
      response.end();
    } catch (error) {
      sendJson(response, 422, { detail: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const runtimeToolMatch = url.pathname.match(/^\/v1\/runtime\/(?:tenants|creators)\/([^/]+)\/agents\/([^/]+)\/tools\/([^/]+)$/);
  if (runtimeToolMatch && request.method === "GET") {
    requireRuntimeServiceAuth(request, context.runtimeServiceToken);
    const tenantId = decodeURIComponent(runtimeToolMatch[1]!);
    if (request.headers["x-hatch-tenant-id"]?.toString() !== tenantId) {
      sendJson(response, 403, { detail: "runtime tenant header does not match route" });
      return;
    }
    try {
      const connection = await context.store.resolveCreatorToolConnection({
        tenantId,
        agentId: decodeURIComponent(runtimeToolMatch[2]!),
        toolId: decodeURIComponent(runtimeToolMatch[3]!)
      });
      sendJson(response, 200, { id: connection.id, tenant_id: connection.tenant_id, kind: connection.kind, secret_ref: connection.secret_ref, secret: connection.secret, config: connection.config, status: connection.status });
    } catch (error) {
      sendJson(response, 404, { detail: error instanceof Error ? error.message : String(error) });
    }
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
    sendJson(response, 200, context.store.listAgentAccessPresentation(account.id));
    return;
  }
  const accessMatch = url.pathname.match(/^\/v1\/user\/agents\/([^/]+)\/([^/]+)\/access$/);
  if (accessMatch && request.method === "POST") {
    const account = await authenticate(request, context.accounts, context.authSecret, "user");
    if (!account) { sendJson(response, 401, { detail: "A valid user account token is required." }); return; }
    const body = await readJsonOptional(request);
    try { sendJson(response, 201, await context.store.grantAgentAccess(account.id, decodeURIComponent(accessMatch[1]!), decodeURIComponent(accessMatch[2]!), typeof body.order_id === "string" ? body.order_id : undefined)); }
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
  sendJson(response, 404, { detail: "Route not found." });
}

async function authenticate(request: http.IncomingMessage, accounts: AccountStoreTs, secret: string, role?: AccountRole): Promise<Account | undefined> {
  const session = await accounts.resolveSession(bearer(request));
  if (session && (!role || session.account.role === role)) return session.account;
  const claims = verifyAuthToken(bearer(request), secret);
  if (!claims || (role && claims.role !== role)) return undefined;
  return accounts.getById(claims.sub);
}

async function authenticateLegacy(token: string | undefined, accounts: AccountStoreTs, secret: string): Promise<Account | undefined> {
  const claims = verifyAuthToken(token, secret);
  if (!claims) return undefined;
  return accounts.getById(claims.sub);
}

function sessionResponse(account: Account, issued: { token: string; session: { absolute_expires_at: string } }): Record<string, unknown> {
  return {
    // Keep the top-level token for older Desktop builds during migration. New
    // clients read session.token and use the opaque, revocable value.
    token: issued.token,
    session: {
      token: issued.token,
      expires_at: issued.session.absolute_expires_at
    },
    account: accountPublic(account)
  };
}

function bearer(request: http.IncomingMessage): string | undefined {
  const value = request.headers.authorization ?? "";
  const [scheme, token] = value.split(" ", 2);
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

function requireRuntimeServiceAuth(request: http.IncomingMessage, configuredToken: string): void {
  if (!configuredToken || bearer(request) !== configuredToken) {
    const error = new Error("A valid Registry runtime service token is required.");
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
}

function errorStatus(error: unknown): number {
  return error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : 500;
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

async function readJsonOptional(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await readBytes(request, 1024 * 1024);
  if (bytes.byteLength === 0) return {};
  const payload = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
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
function corsHeaders(): Record<string, string> { return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type,x-hatch-creator-id" }; }

if (import.meta.url === `file://${process.argv[1]}`) {
  createRegistryServerFromEnvironment().then(({ server }) => {
    console.log(`Hatch TypeScript Registry listening on ${JSON.stringify(server.address())}`);
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
