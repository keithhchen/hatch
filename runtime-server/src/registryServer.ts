import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import {
  AuthRateLimiter,
  TrustedProxyPolicy,
  authRateLimitOptionsFromEnvironment,
  authRequestSourceIp,
  authTrustedProxyPolicyFromEnvironment
} from "./authRateLimit.js";
import {
  AccountStoreTs,
  PasswordHasher,
  PasswordWorkCapacityError,
  accountPublic,
  normalizeAccountIdentity,
  passwordWorkOptionsFromEnvironment,
  validateSigninCredentials,
  validateSignupCredentials,
  verifyAuthToken,
  type Account,
  type AccountRole
} from "./registryAuth.js";
import { RegistryStoreTs } from "./registryStore.js";
import { MAX_AGENT_CORPUS_BUNDLE_BYTES } from "./registryCorpus.js";
import {
  HttpRequestGate,
  PublishWorkGate,
  SessionQueryGate,
  httpRequestLimitOptionsFromEnvironment,
  publishWorkLimitOptionsFromEnvironment,
  sessionQueryLimitOptionsFromEnvironment,
  type GateLease,
} from "./registryRequestLimits.js";

export type RegistryServer = { server: http.Server; close: () => Promise<void> };
type RegistryContext = {
  store: RegistryStoreTs;
  accounts: AccountStoreTs;
  authRateLimiter: AuthRateLimiter;
  sessionQueryGate: SessionQueryGate;
  publishWorkGate: PublishWorkGate;
  trustedProxies: TrustedProxyPolicy;
  publishToken: string;
  runtimeServiceToken: string;
  commerceServiceToken: string;
  authSecret: string;
};

// Creator source text is limited to 5 MiB by CreatorFactoryService. JSON can
// expand a UTF-16 code unit to a six-byte escape (for example, "\\u0000"), so
// leave enough transport headroom without making the Registry body unbounded.
export const CREATOR_FACTORY_JSON_BODY_MAX_BYTES = 32 * 1024 * 1024;

export async function createRegistryServerFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<RegistryServer> {
  const authRateLimitOptions = authRateLimitOptionsFromEnvironment(environment);
  const passwordWorkOptions = passwordWorkOptionsFromEnvironment(environment);
  const trustedProxies = authTrustedProxyPolicyFromEnvironment(environment);
  const store = await RegistryStoreTs.open({ environment });
  const accounts = new AccountStoreTs(store.databasePool(), new PasswordHasher(passwordWorkOptions));
  await accounts.ensureSchema();
  const factoryRepository = creatorFactoryRepositoryForRegistry(environment, store.databasePool());
  await factoryRepository.initialize();
  const factoryService = new CreatorFactoryService(
    factoryRepository,
    path.resolve(environment.HATCH_CREATOR_FACTORY_ROOT ?? "creator-factory-runs")
  );
  const publishToken = environment.HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN?.trim() || "";
  const runtimeServiceToken = environment.HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN?.trim() || "";
  const commerceServiceToken = environment.HATCH_REGISTRY_COMMERCE_SERVICE_TOKEN?.trim() || "";
  const legacyHmacEnabled = environment.HATCH_ENABLE_LEGACY_HMAC_AUTH?.trim().toLowerCase() === "true";
  const authSecret = legacyHmacEnabled ? environment.HATCH_AUTH_SIGNING_SECRET?.trim() || "" : "";
  const authRateLimiter = new AuthRateLimiter(authRateLimitOptions);
  const sessionQueryGate = new SessionQueryGate(sessionQueryLimitOptionsFromEnvironment(environment));
  const publishWorkGate = new PublishWorkGate(publishWorkLimitOptionsFromEnvironment(environment));
  const httpLimits = httpRequestLimitOptionsFromEnvironment(environment);
  const httpRequestGate = new HttpRequestGate(httpLimits);
  const server = http.createServer((request, response) => {
    const suppliedBearer = bearer(request);
    const internalRuntime = Boolean(
      (runtimeServiceToken && request.headers["x-hatch-runtime-service-token"] === runtimeServiceToken)
      || (runtimeServiceToken && suppliedBearer === runtimeServiceToken)
      || (commerceServiceToken && suppliedBearer === commerceServiceToken)
      || (publishToken && suppliedBearer === publishToken)
    );
    const admission = httpRequestGate.begin(
      authRequestSourceIp(request, trustedProxies),
      !internalRuntime,
    );
    if (!admission.allowed) {
      request.resume();
      response.once("finish", () => request.destroy());
      sendJson(response, admission.reason === "source_capacity" ? 429 : 503, {
        detail: "Registry is temporarily busy. Try again shortly.",
      }, { "retry-after": String(admission.retryAfterSeconds), connection: "close" });
      return;
    }
    const routeTask = route(request, response, { store, accounts, authRateLimiter, sessionQueryGate, publishWorkGate, trustedProxies, publishToken, runtimeServiceToken, commerceServiceToken, authSecret })
      .catch((error) => {
        const status = errorStatus(error);
        if (status >= 500) console.error("Registry request failed", error);
        sendJson(response, status, {
          detail: status >= 500
            ? "Registry request failed."
            : error instanceof SyntaxError
              ? "Request body must be valid JSON."
              : error instanceof Error ? error.message : String(error)
        });
      });
    holdAdmissionUntilRequestAndRouteSettle(request, response, routeTask, admission);
  });
  server.maxConnections = httpLimits.maxConnections;
  server.headersTimeout = httpLimits.headersTimeoutMs;
  server.requestTimeout = httpLimits.requestTimeoutMs;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  const port = Number(environment.REGISTRY_PORT ?? 8100);
  const host = environment.REGISTRY_HOST ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return { server, close: async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await factoryRepository.close();
    await store.close();
  } };
}

export function creatorFactoryRepositoryForRegistry(
  environment: NodeJS.ProcessEnv,
  registryPool?: NonNullable<ReturnType<RegistryStoreTs["databasePool"]>>
): CreatorFactoryRepository {
  const factoryDatabaseUrl = environment.HATCH_FACTORY_DATABASE_URL?.trim();
  if (factoryDatabaseUrl) {
    // Registry and Factory Worker intentionally connect through the Factory
    // credential. Never create Factory tables through the Registry role when
    // a least-privilege Factory database URL is configured.
    return new PostgresCreatorFactoryRepository({ connectionString: factoryDatabaseUrl });
  }
  return registryPool
    ? new PostgresCreatorFactoryRepository({ pool: registryPool })
    : new InMemoryCreatorFactoryRepository();
}

async function route(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RegistryContext,
): Promise<void> {
  if (request.method === "OPTIONS") { response.writeHead(204, corsHeaders()); response.end(); return; }
  const url = new URL(request.url ?? "/", "http://registry.local");
  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && (url.pathname === "/readyz" || url.pathname === "/health")) {
    const credentialsReady = !context.production || Boolean(
      context.authSecret
      && context.publishToken
      && context.runtimeServiceToken
      && context.accessServiceToken
      && context.deploymentServiceToken
    );
    try {
      await context.store.checkReady();
      sendJson(response, credentialsReady ? 200 : 503, {
        status: credentialsReady ? "ok" : "unavailable",
        checks: {
          registry_store: "ready",
          service_credentials: credentialsReady ? "ready" : "failed"
        }
      });
    } catch {
      sendJson(response, 503, {
        status: "unavailable",
        checks: {
          registry_store: "failed",
          service_credentials: credentialsReady ? "ready" : "failed"
        }
      });
    }
    return;
  }

  if (url.pathname === "/v1/auth/signup" && request.method === "POST") {
    if (!beginAuthSourceAttempt(request, response, context)) return;
    const body = await readJson(request);
    const email = String(body.email ?? "");
    const password = String(body.password ?? "");
    const role = body.role as AccountRole;
    const displayName = String(body.display_name ?? "");
    let identity = normalizeAccountIdentity(email);
    const attempt = context.authRateLimiter.checkIdentity("signup", identity);
    try {
      identity = validateSignupCredentials(email, password, role, displayName).email;
    } catch (error) {
      const failure = context.authRateLimiter.recordFailure("signup", identity);
      if (attempt.identityLimited) sendRateLimited(response, attempt.retryAfterSeconds);
      else if (failure.limited) sendRateLimited(response, failure.retryAfterSeconds);
      else sendAuthInputError(response, error);
      return;
    }
    let account: Account;
    try {
      account = await context.accounts.create(email, password, role, displayName);
    } catch (error) {
      if (error instanceof PasswordWorkCapacityError) {
        sendAuthBusy(response);
        return;
      }
      const failure = context.authRateLimiter.recordFailure("signup", identity);
      if (attempt.identityLimited) sendRateLimited(response, attempt.retryAfterSeconds);
      else if (failure.limited) sendRateLimited(response, failure.retryAfterSeconds);
      else sendError(response, error, { email_already_registered: [409, "Email is already registered."] });
      return;
    }
    context.authRateLimiter.recordSuccess("signup", identity);
    sendAuthJson(response, 201, sessionResponse(account, await context.accounts.createSession(account)));
    return;
  }
  if (url.pathname === "/v1/auth/signin" && request.method === "POST") {
    if (!beginAuthSourceAttempt(request, response, context)) return;
    const body = await readJson(request);
    const email = String(body.email ?? "");
    const password = String(body.password ?? "");
    let identity = normalizeAccountIdentity(email);
    const attempt = context.authRateLimiter.checkIdentity("signin", identity);
    try {
      identity = validateSigninCredentials(email, password);
    } catch (error) {
      const failure = context.authRateLimiter.recordFailure("signin", identity);
      if (attempt.identityLimited) sendRateLimited(response, attempt.retryAfterSeconds);
      else if (failure.limited) sendRateLimited(response, failure.retryAfterSeconds);
      else sendAuthInputError(response, error);
      return;
    }
    const account = await context.accounts.getByEmail(identity);
    let passwordMatches: boolean;
    try {
      passwordMatches = await context.accounts.verifyPassword(password, account);
    } catch (error) {
      if (error instanceof PasswordWorkCapacityError) {
        sendAuthBusy(response);
        return;
      }
      throw error;
    }
    if (!passwordMatches || !account) {
      const failure = context.authRateLimiter.recordFailure("signin", identity);
      if (attempt.identityLimited) sendRateLimited(response, attempt.retryAfterSeconds);
      else if (failure.limited) sendRateLimited(response, failure.retryAfterSeconds);
      else sendAuthJson(response, 401, { detail: "Email or password is incorrect." });
      return;
    }
    context.authRateLimiter.recordSuccess("signin", identity);
    sendAuthJson(response, 200, sessionResponse(account, await context.accounts.createSession(account)));
    return;
  }
  if (url.pathname === "/v1/auth/me" && request.method === "GET") {
    const lease = beginSessionQuery(request, response, context);
    if (!lease) return;
    try {
      const token = bearer(request);
      const session = await context.accounts.resolveSession(token);
      if (session) {
        sendAuthJson(response, 200, { ...accountPublic(session.account), session_expires_at: session.session.absolute_expires_at });
        return;
      }
      const account = await authenticateLegacy(token, context.accounts, context.authSecret);
      if (!account) { sendAuthJson(response, 401, { detail: "A valid account token is required." }); return; }
      sendAuthJson(response, 200, accountPublic(account));
    } finally {
      lease.release();
    }
    return;
  }
  if (url.pathname === "/v1/auth/logout" && request.method === "POST") {
    const lease = beginSessionQuery(request, response, context);
    if (!lease) return;
    try {
      await context.accounts.revokeSession(bearer(request));
      response.writeHead(204, { ...corsHeaders(), "cache-control": "no-store" });
      response.end();
    } finally {
      lease.release();
    }
    return;
  }

  const internalFactoryStageMatch = url.pathname.match(/^\/v1\/internal\/deployments\/factory-runs\/([^/]+)\/stage$/);
  if (internalFactoryStageMatch && request.method === "POST") {
    if (!context.deploymentServiceToken || bearer(request) !== context.deploymentServiceToken) {
      sendJson(response, 403, { detail: "A valid Registry deployment service token is required." });
      return;
    }
    const body = await readJson(request);
    const creatorId = requiredString(body.creator_id);
    const operationId = requiredString(body.operation_id);
    const corpusDigest = requiredString(body.corpus_digest);
    if (!creatorId || !validDeploymentOperationId(operationId) || !isCorpusDigest(corpusDigest)) {
      sendJson(response, 400, { detail: "creator_id, operation_id, and a valid corpus_digest are required." });
      return;
    }
    const runId = decodeURIComponent(internalFactoryStageMatch[1]!);
    try {
      const candidate = await context.factoryService.publishableCorpus(creatorId, runId);
      if (candidate.corpusDigest !== corpusDigest) {
        sendJson(response, 409, {
          detail: "The Factory candidate changed. Review it again.",
          code: "candidate_changed",
          expected_corpus_digest: corpusDigest,
          current_corpus_digest: candidate.corpusDigest,
        });
        return;
      }
      const staged = await context.store.stageAgentCorpusDirectory(
        creatorId,
        candidate.agentId,
        candidate.corpusRoot,
        candidate.corpusDigest,
      );
      sendJson(response, 201, {
        ...staged,
        factory_run_id: candidate.runId,
        operation_id: operationId,
        current: false,
      });
    } catch (error) {
      if (error instanceof RegistryFactoryCandidateChangedError) {
        sendJson(response, 409, {
          detail: "The Factory candidate changed. Review it again.",
          code: error.code,
          expected_corpus_digest: error.expectedCorpusDigest,
          current_corpus_digest: error.currentCorpusDigest,
        });
      } else {
        sendError(response, error, {
          invalid_status: [409, "Factory candidate is not publishable."],
          run_not_found: [404, "Factory run not found."],
        });
      }
    }
    return;
  }

  const internalReleaseMatch = url.pathname.match(
    /^\/v1\/internal\/deployments\/agent-corpora\/([^/]+)\/([^/]+)\/releases\/([^/]+)$/
  );
  if (internalReleaseMatch && request.method === "GET") {
    if (!context.deploymentServiceToken || bearer(request) !== context.deploymentServiceToken) {
      sendJson(response, 403, { detail: "A valid Registry deployment service token is required." });
      return;
    }
    const creatorId = decodeURIComponent(internalReleaseMatch[1]!);
    const agentId = decodeURIComponent(internalReleaseMatch[2]!);
    const corpusDigest = decodeURIComponent(internalReleaseMatch[3]!);
    if (!creatorId || !agentId || !isCorpusDigest(corpusDigest)) {
      sendJson(response, 400, { detail: "creator id, agent id, and a valid sha256 Corpus digest are required." });
      return;
    }
    const release = await context.store.getAgentCorpusRelease(creatorId, agentId, corpusDigest);
    if (!release) {
      sendJson(response, 404, { detail: "The requested Agent Corpus release is not materialized." });
      return;
    }
    sendJson(response, 200, release);
    return;
  }

  const internalActivationMatch = url.pathname.match(/^\/v1\/internal\/deployments\/agent-corpora\/([^/]+)\/releases\/([^/]+)\/activate$/);
  if (internalActivationMatch && request.method === "POST") {
    if (!context.deploymentServiceToken || bearer(request) !== context.deploymentServiceToken) {
      sendJson(response, 403, { detail: "A valid Registry deployment service token is required." });
      return;
    }
    const body = await readJson(request);
    const creatorId = requiredString(body.creator_id);
    const operationId = requiredString(body.operation_id);
    const hasExpectedDigest = Object.prototype.hasOwnProperty.call(body, "expected_current_digest");
    const expectedCurrentDigest = body.expected_current_digest === null
      ? null
      : requiredString(body.expected_current_digest);
    if (!creatorId
      || !validDeploymentOperationId(operationId)
      || !hasExpectedDigest
      || (expectedCurrentDigest !== null && !isCorpusDigest(expectedCurrentDigest))) {
      sendJson(response, 400, {
        detail: "creator_id, operation_id, and expected_current_digest (null or sha256 digest) are required."
      });
      return;
    }
    const agentId = decodeURIComponent(internalActivationMatch[1]!);
    const corpusDigest = decodeURIComponent(internalActivationMatch[2]!);
    try {
      const activated = await context.store.activateAgentCorpusRelease(
        creatorId,
        agentId,
        corpusDigest,
        { operationId, expectedCurrentDigest },
      );
      sendJson(response, 200, {
        agent_corpus: activated,
        current: true,
        operation_id: operationId,
      });
    } catch (error) {
      if (error instanceof RegistryDeploymentConflictError) {
        sendJson(response, 409, {
          detail: "The current Agent Corpus changed before activation.",
          code: error.code,
          expected_current_digest: error.expectedCurrentDigest,
          current_corpus_digest: error.currentCorpusDigest,
          target_corpus_digest: error.targetCorpusDigest,
        });
      } else {
        sendError(response, error, {
          invalid_corpus_digest: [400, "A valid sha256 Corpus digest is required."],
          invalid_deployment_operation_id: [400, "A valid deployment operation_id is required."],
          invalid_expected_current_digest: [400, "expected_current_digest must be null or a valid sha256 digest."],
          agent_corpus_release_not_found: [404, "The requested Agent Corpus release is not materialized."],
        });
      }
    }
    return;
  }

  const factoryPublishMatch = url.pathname.match(/^\/v1\/creator\/factory-runs\/([^/]+)\/publish$/);
  if (factoryPublishMatch && request.method === "POST") {
    const account = await authenticate(request, context.accounts, context.authSecret, "creator");
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
    try {
      const body = await readJsonOptional(request);
      const requestedDigest = requiredString(body.corpus_digest);
      if (!isCorpusDigest(requestedDigest)) {
        sendJson(response, 400, { detail: "A valid corpus_digest for the reviewed Factory candidate is required." });
        return;
      }
      const candidate = await context.factoryService.publishableCorpus(account.id, decodeURIComponent(factoryPublishMatch[1]!));
      if (requestedDigest !== candidate.corpusDigest) {
        sendJson(response, 409, { detail: "The Factory candidate changed. Review it again.", code: "candidate_changed" });
        return;
      }
      const published = await context.store.publishAgentCorpusDirectory(
        account.id,
        candidate.agentId,
        candidate.corpusRoot,
        candidate.corpusDigest,
      );
      sendJson(response, 201, { ...published, factory_run_id: candidate.runId });
    } catch (error) {
      if (error instanceof RegistryFactoryCandidateChangedError) {
        sendJson(response, 409, {
          detail: "The Factory candidate changed. Review it again.",
          code: error.code,
          expected_corpus_digest: error.expectedCorpusDigest,
          current_corpus_digest: error.currentCorpusDigest,
        });
      } else {
        sendError(response, error, { invalid_status: [409, "Factory candidate is not publishable."] });
      }
    }
    return;
  }

  if (url.pathname.startsWith("/v1/creator/factory-runs")) {
    const account = await authenticate(request, context.accounts, context.authSecret, "creator");
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
    const result = await handleCreatorFactoryHttp({
      method: request.method ?? "GET",
      pathname: url.pathname,
      headers: { "idempotency-key": request.headers["idempotency-key"]?.toString() },
      ...(request.method === "GET" ? {} : {
        body: await readJsonOptional(request, CREATOR_FACTORY_JSON_BODY_MAX_BYTES)
      }),
      creator: account
    }, context.factoryService);
    if (result) { sendJson(response, result.status, result.body); return; }
  }

  if (url.pathname === "/v1/catalog/agents" && request.method === "GET") {
    const limit = boundedQueryInteger(url, "limit", 20, 1, 20);
    const offset = boundedQueryInteger(url, "offset", 0, 0, 100_000);
    const rows = await context.store.listAllAgentCorpora({ limit: limit + 1, offset });
    const page = rows.slice(0, limit);
    sendJson(response, 200, page, {
      "x-hatch-page-limit": String(limit),
      "x-hatch-page-offset": String(offset),
      ...(rows.length > limit ? { "x-hatch-next-offset": String(offset + limit) } : {}),
    });
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
    const account = await authenticate(request, response, context, "creator");
    if (account === SESSION_QUERY_REJECTED) return;
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
    sendJson(response, 200, await context.store.listAgentCorpora(account.id));
    return;
  }
  const activateCorpusMatch = url.pathname.match(/^\/v1\/creator\/agent-corpora\/([^/]+)\/releases\/([^/]+)\/activate$/);
  if (activateCorpusMatch && request.method === "POST") {
    const account = await authenticate(request, context.accounts, context.authSecret, "creator");
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
    try {
      const activated = await context.store.activateAgentCorpusRelease(
        account.id,
        decodeURIComponent(activateCorpusMatch[1]!),
        decodeURIComponent(activateCorpusMatch[2]!),
      );
      sendJson(response, 200, { agent_corpus: activated, current: true });
    } catch (error) {
      sendError(response, error, {
        invalid_corpus_digest: [400, "A valid sha256 Corpus digest is required."],
        agent_corpus_release_not_found: [404, "The requested Agent Corpus release is not materialized."],
      });
    }
    return;
  }
  if (url.pathname === "/v1/user/agent-access" && request.method === "GET") {
    const account = await authenticate(request, response, context, "user");
    if (account === SESSION_QUERY_REJECTED) return;
    if (!account) { sendJson(response, 401, { detail: "A valid user account token is required." }); return; }
    const requestedEntitlement = url.searchParams.get("entitlement_id");
    if (requestedEntitlement !== null) {
      if (!requestedEntitlement || requestedEntitlement.length > 256) {
        const error = new Error("entitlement_id must contain at most 256 characters.");
        (error as Error & { status?: number }).status = 400;
        throw error;
      }
      sendJson(
        response,
        200,
        await context.store.listAgentAccessPresentation(account.id, { entitlementId: requestedEntitlement }),
      );
      return;
    }
    const limit = boundedQueryInteger(url, "limit", 20, 1, 20);
    const offset = boundedQueryInteger(url, "offset", 0, 0, 100_000);
    const rows = await context.store.listAgentAccessPresentation(account.id, { limit: limit + 1, offset });
    const page = rows.slice(0, limit);
    sendJson(response, 200, page, {
      "x-hatch-page-limit": String(limit),
      "x-hatch-page-offset": String(offset),
      ...(rows.length > limit ? { "x-hatch-next-offset": String(offset + limit) } : {}),
    });
    return;
  }

  if (url.pathname === "/v1/commerce/agent-access" && request.method === "POST") {
    requireCommerceServiceAuth(request, context.commerceServiceToken);
    const body = await readJson(request);
    const userId = requiredCommerceField(body, "user_id");
    const creatorId = requiredCommerceField(body, "creator_id");
    const agentId = requiredCommerceField(body, "agent_id");
    const orderId = requiredCommerceField(body, "order_id");
    try { sendJson(response, 201, await context.store.grantAgentAccess(userId, creatorId, agentId, orderId)); }
    catch (error) { sendError(response, error, { agent_not_found: [404, "Agent not found."], order_id_required: [400, "order_id is required."] }); }
    return;
  }

  if (url.pathname === "/v1/agent-corpora" && request.method === "POST") {
    if (!context.publishToken || bearer(request) !== context.publishToken) { sendJson(response, 403, { detail: "A valid Registry publish token is required." }); return; }
    const creatorId = url.searchParams.get("creator_id") ?? "";
    const agentId = url.searchParams.get("agent_id") ?? "";
    const lease = beginPublishWork(response, context, "registry-publish-service", false);
    if (!lease) return;
    try {
      sendJson(response, 201, await context.store.publishAgentCorpusBundle(creatorId, agentId, await readBytes(request, MAX_AGENT_CORPUS_BUNDLE_BYTES)));
    } catch (error) {
      sendError(response, error, { agent_not_found: [404, "Agent not found."] });
    } finally {
      lease.release();
    }
    return;
  }
  if (url.pathname === "/v1/creator/agent-corpora" && request.method === "POST") {
    const account = await authenticate(request, response, context, "creator");
    if (account === SESSION_QUERY_REJECTED) return;
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
    const agentId = url.searchParams.get("agent_id") ?? "";
    const lease = beginPublishWork(response, context, `creator:${account.id}`);
    if (!lease) return;
    try {
      sendJson(response, 201, await context.store.publishAgentCorpusBundle(account.id, agentId, await readBytes(request, MAX_AGENT_CORPUS_BUNDLE_BYTES)));
    } catch (error) {
      sendError(response, error);
    } finally {
      lease.release();
    }
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

const SESSION_QUERY_REJECTED = Symbol("session-query-rejected");

async function authenticate(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RegistryContext,
  role?: AccountRole,
): Promise<Account | undefined | typeof SESSION_QUERY_REJECTED> {
  const lease = beginSessionQuery(request, response, context);
  if (!lease) return SESSION_QUERY_REJECTED;
  try {
    const session = await context.accounts.resolveSession(bearer(request));
    if (session && (!role || session.account.role === role)) return session.account;
    const claims = verifyAuthToken(bearer(request), context.authSecret);
    if (!claims || (role && claims.role !== role)) return undefined;
    return context.accounts.getById(claims.sub);
  } finally {
    lease.release();
  }
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

function requiredString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validDeploymentOperationId(value: string): boolean {
  return value.length > 0 && value.length <= 200;
}

function isCorpusDigest(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function requireRuntimeServiceAuth(request: http.IncomingMessage, configuredToken: string): void {
  if (!configuredToken || bearer(request) !== configuredToken) {
    const error = new Error("A valid Registry runtime service token is required.");
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
}

function requireCommerceServiceAuth(request: http.IncomingMessage, configuredToken: string): void {
  if (!configuredToken || bearer(request) !== configuredToken) {
    const error = new Error("A valid Registry commerce service token is required.");
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
}

function requiredCommerceField(body: Record<string, unknown>, field: string): string {
  const value = typeof body[field] === "string" ? body[field].trim() : "";
  if (!value || value.length > 256) {
    const error = new Error(`${field} is required and must not exceed 256 characters.`);
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  return value;
}

function boundedQueryInteger(
  url: URL,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    const error = new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  return value;
}

function holdAdmissionUntilRequestAndRouteSettle(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  routeTask: Promise<void>,
  lease: GateLease,
): void {
  let routeSettled = false;
  let requestSettled = request.complete || request.readableEnded || request.destroyed;
  let released = false;
  const releaseIfDone = () => {
    if (released || !routeSettled || !requestSettled) return;
    released = true;
    lease.release();
  };
  const settleRequest = () => {
    requestSettled = true;
    releaseIfDone();
  };
  request.once("end", settleRequest);
  request.once("aborted", settleRequest);
  request.once("close", settleRequest);
  response.once("finish", () => {
    // If a route rejected before consuming a POST body, close that connection
    // after the response instead of letting an untracked slow upload linger.
    if (!request.complete && !request.destroyed) request.destroy();
  });
  const settleRoute = () => {
    routeSettled = true;
    releaseIfDone();
  };
  void routeTask.then(settleRoute, settleRoute);
}

function beginSessionQuery(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RegistryContext,
): GateLease | undefined {
  const internalRuntime = context.runtimeServiceToken
    && request.headers["x-hatch-runtime-service-token"] === context.runtimeServiceToken;
  const decision = context.sessionQueryGate.begin(
    authRequestSourceIp(request, context.trustedProxies),
    !internalRuntime,
  );
  if (decision.allowed) return decision;
  if (decision.reason === "global_capacity") {
    sendAuthJson(response, 503, { detail: "Authentication is temporarily busy. Try again shortly." }, {
      "retry-after": String(decision.retryAfterSeconds),
    });
  } else {
    sendAuthJson(response, 429, { detail: "Too many session checks. Try again later." }, {
      "retry-after": String(decision.retryAfterSeconds),
    });
  }
  return undefined;
}

function beginPublishWork(
  response: http.ServerResponse,
  context: RegistryContext,
  publisher: string,
  enforceRate = true,
): GateLease | undefined {
  const decision = context.publishWorkGate.begin(publisher, enforceRate);
  if (decision.allowed) return decision;
  const publisherLimited = decision.reason === "publisher_capacity" || decision.reason === "publisher_rate";
  sendJson(
    response,
    publisherLimited ? 429 : 503,
    { detail: "Agent Corpus publishing is temporarily busy. Try again shortly." },
    { "retry-after": String(decision.retryAfterSeconds) },
  );
  return undefined;
}

function errorStatus(error: unknown): number {
  if (error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  if (error instanceof SyntaxError) return 400;
  if (error instanceof Error && error.message === "Request body is too large") return 413;
  return 500;
}

async function readBytes(request: http.IncomingMessage, max = 64 * 1024 * 1024): Promise<Uint8Array> {
  const declaredLength = request.headers["content-length"];
  if (typeof declaredLength === "string") {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) throw new SyntaxError("Content-Length is invalid");
    if (parsedLength > max) throw new Error("Request body is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > max) {
      exceeded = true;
      continue;
    }
    if (!exceeded) chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const payload = JSON.parse(Buffer.from(await readBytes(request, 1024 * 1024)).toString("utf8")) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("JSON body must be an object");
  return payload as Record<string, unknown>;
}

function beginAuthSourceAttempt(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RegistryContext,
): boolean {
  const decision = context.authRateLimiter.beginSourceAttempt(
    authRequestSourceIp(request, context.trustedProxies),
  );
  if (decision.allowed) return true;
  sendRateLimited(response, decision.retryAfterSeconds);
  return false;
}

function sendRateLimited(response: http.ServerResponse, retryAfterSeconds: number): void {
  sendAuthJson(response, 429, { detail: "Too many authentication attempts. Try again later." }, {
    "retry-after": String(retryAfterSeconds)
  });
}

function sendAuthBusy(response: http.ServerResponse): void {
  sendAuthJson(response, 503, { detail: "Authentication is temporarily busy. Try again shortly." }, {
    "retry-after": "1"
  });
}

function sendAuthInputError(response: http.ServerResponse, error: unknown): void {
  const details: Record<string, string> = {
    email_invalid: "Enter a valid email address no longer than 254 characters.",
    password_required: "Enter a password.",
    password_too_short: "Password must contain at least 8 characters.",
    password_too_long: "Password must not exceed 1024 UTF-8 bytes.",
    role_invalid: "Account role must be user or creator.",
    display_name_required: "Display name is required.",
    display_name_too_long: "Display name must not exceed 128 characters."
  };
  const code = error instanceof Error ? error.message : "auth_input_invalid";
  sendAuthJson(response, 400, { detail: details[code] ?? "Authentication input is invalid." });
}

function sendAuthJson(
  response: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  sendJson(response, status, payload, { "cache-control": "no-store", ...headers });
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, { ...corsHeaders(), "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(payload));
}
function sendError(response: http.ServerResponse, error: unknown, known: Record<string, [number, string]> = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  const expected = known[message];
  if (expected) {
    sendJson(response, expected[0], { detail: expected[1] });
    return;
  }
  if (error instanceof Error && error.name === "AgentCorpusVerificationError") {
    sendJson(response, 422, { detail: message });
    return;
  }
  throw error;
}
function corsHeaders(): Record<string, string> { return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type,x-hatch-creator-id", "access-control-expose-headers": "retry-after,x-hatch-page-limit,x-hatch-page-offset,x-hatch-next-offset" }; }

if (import.meta.url === `file://${process.argv[1]}`) {
  createRegistryServerFromEnvironment().then(({ server }) => {
    console.log(`Hatch TypeScript Registry listening on ${JSON.stringify(server.address())}`);
  }).catch((error) => { writeOperationalError("registry_startup_failed", error); process.exitCode = 1; });
}
