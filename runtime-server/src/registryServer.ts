import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";
import { AccountStoreTs, accountPublic, createAuthToken, verifyAuthToken, verifyPassword, type Account, type AccountRole } from "./registryAuth.js";
import { ControlPlaneError, RegistryStoreTs, type ToolConnection } from "./registryStore.js";
import { ElevenLabsVoiceProvider } from "./voice.js";

export type RegistryServer = { server: http.Server; close: () => Promise<void> };

export async function createRegistryServerFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<RegistryServer> {
  const store = await RegistryStoreTs.open({
    environment,
    voiceProvider: ElevenLabsVoiceProvider.fromEnvironment(environment),
  });
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
    const entries = await context.store.listAllAgentCorpora();
    sendJson(response, 200, entries.map(withVoiceStatus(context.store)));
    return;
  }
  if (url.pathname === "/v1/creator/agents" && request.method === "GET") {
    const account = await authenticate(request, context.accounts, context.authSecret, "creator");
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
    sendJson(response, 200, (await context.store.listAgentCorpora(account.id)).map(withVoiceStatus(context.store)));
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

  const voiceMatch = url.pathname.match(/^\/v1\/creators\/([^/]+)\/voice$/);
  if (voiceMatch && request.method === "PUT") {
    const account = await authenticate(request, context.accounts, context.authSecret, "creator");
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
    const pathCreatorId = decodeURIComponent(voiceMatch[1]!);
    if (account.id !== pathCreatorId) { sendJson(response, 403, { detail: "creator path does not match authenticated creator" }); return; }
    try {
      const parts = parseMultipart(Buffer.from(await readBytes(request, 32 * 1024 * 1024)));
      const sample = parts.files[0];
      if (!sample) { sendJson(response, 400, { detail: "A voice sample audio file is required." }); return; }
      const consentVersion = parts.fields.consent_version ?? "";
      if (!consentVersion) { sendJson(response, 400, { detail: "consent_version is required." }); return; }
      if (sample.byteLength > 25 * 1024 * 1024) { sendJson(response, 400, { detail: "Voice sample must be 25MB or smaller." }); return; }
      const asset = await context.store.upsertVoice({
        creatorId: account.id,
        creatorName: account.display_name || account.id,
        sample,
        sampleFormat: "mp3",
        consentVersion,
      });
      sendJson(response, 201, asset);
    } catch (error) { sendError(response, error); }
    return;
  }
  if (voiceMatch && request.method === "GET") {
    const account = await authenticate(request, context.accounts, context.authSecret, "creator");
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
    const asset = context.store.getVoice(account.id);
    if (!asset) { sendJson(response, 404, { detail: "No voice asset for this creator." }); return; }
    sendJson(response, 200, asset);
    return;
  }
  if (voiceMatch && request.method === "DELETE") {
    const account = await authenticate(request, context.accounts, context.authSecret, "creator");
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
    await context.store.revokeVoice(account.id);
    sendJson(response, 204, undefined);
    return;
  }

  if (url.pathname === "/v1/tts" && request.method === "POST") {
    if (!context.publishToken || bearer(request) !== context.publishToken) { sendJson(response, 403, { detail: "A valid Registry publish token is required." }); return; }
    const body = await readJson(request);
    const creatorId = String(body.creator_id ?? "").trim();
    const agentId = String(body.agent_id ?? "").trim();
    const text = String(body.text ?? "").trim();
    if (!creatorId || !agentId || !text) { sendJson(response, 400, { detail: "creator_id, agent_id and text are required." }); return; }
    if (text.length > 5000) { sendJson(response, 400, { detail: "text must be 5000 characters or fewer." }); return; }
    try {
      const result = await context.store.synthesizeVoice({
        creatorId,
        agentId,
        text,
        previousRequestIds: Array.isArray(body.previous_request_ids) ? body.previous_request_ids.map(String) : [],
      });
      sendAudio(response, result.audio, result.requestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "voice_not_configured") { sendJson(response, 403, { detail: "This Creator has no active voice." }); return; }
      sendError(response, error);
    }
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
  const name = error instanceof Error ? error.name : "";
  if (name === "VoiceProviderUnavailable" || message === "voice_provider_not_configured") {
    sendJson(response, 503, { detail: "Voice synthesis is temporarily unavailable." });
    return;
  }
  const [status, detail] = known[message] ?? (error instanceof Error && error.name === "AgentCorpusVerificationError" ? [422, message] : [422, message]);
  sendJson(response, status, { detail });
}
function corsHeaders(): Record<string, string> { return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "authorization,content-type,x-hatch-creator-id" }; }

function withVoiceStatus(store: RegistryStoreTs): (entry: Record<string, unknown>) => Record<string, unknown> {
  return (entry) => {
    const creatorId = String(entry.creator_id ?? "");
    const voice = store.voiceStatus(creatorId);
    if (!voice) return { ...entry, voice: { enabled: false } };
    return { ...entry, voice };
  };
}

function sendAudio(response: http.ServerResponse, audio: Uint8Array, requestId: string): void {
  response.writeHead(200, {
    ...corsHeaders(),
    "content-type": "audio/mpeg",
    "content-length": audio.byteLength,
    "x-request-id": requestId,
  });
  response.end(Buffer.from(audio));
}

function parseMultipart(body: Buffer): { files: Uint8Array[]; fields: Record<string, string> } {
  const boundaryMatch = /^--([^\r\n]+)/.exec(body.subarray(0, 256).toString("latin1"));
  if (!boundaryMatch) throw new Error("Request body must be multipart/form-data");
  const boundary = Buffer.from(`--${boundaryMatch[1]}`, "latin1");
  const files: Uint8Array[] = [];
  const fields: Record<string, string> = {};
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf(boundary, cursor);
    if (start < 0) break;
    const partStart = start + boundary.length;
    let end = body.indexOf(boundary, partStart);
    if (end < 0) break;
    const raw = body.subarray(partStart, end);
    const headerEnd = raw.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) { cursor = end; continue; }
    const headers = raw.subarray(0, headerEnd).toString("latin1");
    const content = raw.subarray(headerEnd + 4, raw.length - 2 >= headerEnd + 4 ? raw.length - 2 : headerEnd + 4);
    const nameMatch = /name="([^"]+)"/.exec(headers);
    const name = nameMatch ? nameMatch[1] : "";
    if (/filename="/.test(headers)) {
      files.push(new Uint8Array(content));
    } else {
      fields[name] = content.toString("utf8").trim();
    }
    cursor = end;
  }
  if (files.length === 0 && Object.keys(fields).length === 0) throw new Error("multipart body is empty or malformed");
  return { files, fields };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createRegistryServerFromEnvironment().then(({ server }) => {
    console.log(`Hatch TypeScript Registry listening on ${JSON.stringify(server.address())}`);
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
