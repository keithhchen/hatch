import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import type { AgentCorpus, AgentCorpusResolver } from "./agentCorpus.js";
import type { AgentRuntime } from "./agentRuntime.js";
import {
  EntitlementError,
  RegistryEntitlementResolver,
  type AuthIdentityResolver,
  type EntitlementBinding,
  type EntitlementResolver
} from "./entitlements.js";
import { createRuntimeServer, type RuntimeServer } from "./index.js";

test("Runtime delegates opaque session identity to the configured Registry verifier", async () => {
  const identityResolver = {
    resolveIdentity: async (token?: string) => token === "opaque-user"
      ? { sub: "user_jordan", role: "user" as const, exp: Math.floor(Date.now() / 1000) + 3600 }
      : undefined
  };
  const entitlementResolver = {
    list: async () => [],
    resolve: async () => { throw new Error("not entitled"); }
  };
  const runtime = createRuntimeServer({ authIdentityResolver: identityResolver, entitlementResolver });
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const valid = await fetch(`http://127.0.0.1:${address.port}/v1/me/creator-agents`, {
      headers: { authorization: "Bearer opaque-user" }
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { creator_agents: [] });

    const invalid = await fetch(`http://127.0.0.1:${address.port}/v1/me/creator-agents`, {
      headers: { authorization: "Bearer not-a-session" }
    });
    assert.equal(invalid.status, 401);
  } finally {
    await runtime.close();
  }
});

test("Runtime rejects another user's entitlement for an introspected session", async () => {
  const entitlement = {
    entitlement_id: "ent_jordan_resume",
    order_id: "order_jordan_resume",
    user_id: "user_jordan",
    creator_id: "creator_maya",
    product_id: "product_resume",
    agent_id: "agent_resume",
    status: "active" as const
  };
  const identityResolver = {
    resolveIdentity: async (token?: string) => token === "opaque-mallory"
      ? { sub: "user_mallory", role: "user" as const, exp: Math.floor(Date.now() / 1000) + 3600 }
      : undefined
  };
  // Simulate a Registry authorization regression: both lookups return an
  // active binding, but it belongs to a different account than introspection.
  const entitlementResolver = {
    list: async () => [entitlement],
    resolve: async () => entitlement
  };
  const corpus = {
    agent_id: entitlement.agent_id,
    creator: { id: entitlement.creator_id, name: "Maya" },
    product: {
      id: entitlement.product_id,
      name: "Resume Review",
      boundaries: [],
      presentation: {}
    },
    tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }]
  };
  const agentCorpusResolver = {
    resolve: async () => ({
      root: "/tmp/hatch-runtime-auth-boundary",
      corpus,
      digest: `sha256:${"0".repeat(64)}`
    })
  } as unknown as AgentCorpusResolver;
  const runtime = createRuntimeServer({ authIdentityResolver: identityResolver, entitlementResolver, agentCorpusResolver });
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");

  let socket: WebSocket | undefined;
  try {
    const library = await fetch(`http://127.0.0.1:${address.port}/v1/me/creator-agents`, {
      headers: { authorization: "Bearer opaque-mallory" }
    });
    const libraryBody = await library.json() as { error?: { code?: string } };

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/runtime`);
    const helloResponse = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket!.once("error", reject);
      socket!.once("message", (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
      socket!.once("open", () => socket!.send(JSON.stringify({
        type: "client.hello",
        protocol_version: "0.6",
        installation_id: "desktop-mallory",
        auth_token: "opaque-mallory",
        entitlement_id: entitlement.entitlement_id,
        creator_id: entitlement.creator_id,
        agent_id: entitlement.agent_id,
        local_tools: []
      })));
    });

    assert.deepEqual({
      libraryStatus: library.status,
      libraryError: libraryBody.error?.code,
      helloType: helloResponse.type,
      helloError: (helloResponse.error as { code?: string } | undefined)?.code
    }, {
      libraryStatus: 403,
      libraryError: "entitlement_lookup_failed",
      helloType: "turn.failed",
      helloError: "agent_entitlement_mismatch"
    });
  } finally {
    socket?.close();
    await runtime.close();
  }
});

test("Runtime blocks a real WebSocket turn when the opaque session is revoked after hello", async () => {
  const scenario = await createRevocableRuntimeScenario();
  try {
    const socket = await connectAuthorizedSocket(scenario.runtimePort, scenario.entitlement);
    scenario.socket = socket;
    scenario.registryState.sessionActive = false;

    const response = nextSocketMessage(socket);
    socket.send(JSON.stringify(clientMessage("run-session-revoked")));
    const failed = await response;

    assert.deepEqual(failed, {
      type: "turn.failed",
      run_id: "run-session-revoked",
      error: {
        code: "authentication_required",
        message: "Your Hatch session is no longer valid. Sign in again."
      }
    });
    assert.equal(scenario.runCalls(), 0);
    assert.deepEqual(scenario.registryCalls, { identity: 2, access: 1 });
  } finally {
    await scenario.close();
  }
});

test("Runtime blocks a real WebSocket turn when its entitlement is revoked after hello", async () => {
  const scenario = await createRevocableRuntimeScenario();
  try {
    const socket = await connectAuthorizedSocket(scenario.runtimePort, scenario.entitlement);
    scenario.socket = socket;
    scenario.registryState.entitlementActive = false;

    const response = nextSocketMessage(socket);
    socket.send(JSON.stringify(clientMessage("run-entitlement-revoked")));
    const failed = await response;

    assert.deepEqual(failed, {
      type: "turn.failed",
      run_id: "run-entitlement-revoked",
      error: {
        code: "entitlement_required",
        message: "Access to this Creator Agent is no longer available. Refresh your Creator Agents and choose an available Agent."
      }
    });
    assert.equal(scenario.runCalls(), 0);
    assert.deepEqual(scenario.registryCalls, { identity: 2, access: 2 });
  } finally {
    await scenario.close();
  }
});

test("Runtime re-introspects a Creator session per turn without requiring a buyer entitlement", async () => {
  let identityCalls = 0;
  let runCalls = 0;
  const identityResolver = {
    resolveIdentity: async (token?: string) => {
      identityCalls += 1;
      return token === "opaque-creator-session"
        ? { sub: "creator_maya", role: "creator" as const, exp: Math.floor(Date.now() / 1000) + 3_600 }
        : undefined;
    }
  };
  const entitlement = {
    entitlement_id: "unused-creator-entitlement",
    user_id: "creator_maya",
    creator_id: "creator_maya",
    product_id: "product_resume",
    agent_id: "agent_resume",
    status: "active" as const
  };
  const corpus = revocableTestCorpus(entitlement);
  const agentCorpusResolver = {
    resolve: async () => ({
      // An empty root keeps this focused on auth compatibility; protected
      // materialization has separate full-Corpus integration coverage.
      root: "",
      corpus,
      digest: `sha256:${"2".repeat(64)}`
    })
  } as unknown as AgentCorpusResolver;
  const agentRuntime: AgentRuntime = {
    async *run(input) {
      runCalls += 1;
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  };
  const runtime = createRuntimeServer({
    createRuntime: () => agentRuntime,
    authIdentityResolver: identityResolver,
    agentCorpusResolver
  });
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");

  let socket: WebSocket | undefined;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/runtime`);
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", reject);
    });
    const readyResponse = nextSocketMessage(socket);
    socket.send(JSON.stringify({
      type: "client.hello",
      protocol_version: "0.6",
      installation_id: "desktop-creator-maya",
      auth_token: "opaque-creator-session",
      creator_id: "creator_maya",
      agent_id: "agent_resume",
      local_tools: []
    }));
    assert.equal((await readyResponse).type, "session.ready");

    const completedResponse = waitForSocketMessage(socket, (message) => message.type === "turn.completed");
    socket.send(JSON.stringify(clientMessage("run-creator-authorized")));
    const completed = await completedResponse;
    assert.equal(completed.run_id, "run-creator-authorized");
    assert.equal(runCalls, 1);
    assert.equal(identityCalls, 2);
  } finally {
    socket?.close();
    await runtime.close();
  }
});

test("Runtime rechecks a fixture entitlement every turn without an identity resolver", async () => {
  const entitlement = testEntitlement();
  let active = true;
  let entitlementCalls = 0;
  const entitlementResolver: EntitlementResolver = {
    list: async () => active ? [entitlement] : [],
    resolve: async () => {
      entitlementCalls += 1;
      if (!active) {
        throw new EntitlementError("entitlement_not_found", "fixture entitlement revoked");
      }
      return entitlement;
    }
  };
  const boundary = await startBoundaryRuntime(entitlement, { entitlementResolver });
  let socket: WebSocket | undefined;
  try {
    socket = await connectAuthorizedSocket(boundary.port, entitlement);
    active = false;
    const failedResponse = nextSocketMessage(socket);
    socket.send(JSON.stringify(clientMessage("run-fixture-revoked")));

    assert.deepEqual(await failedResponse, {
      type: "turn.failed",
      run_id: "run-fixture-revoked",
      error: {
        code: "entitlement_required",
        message: "Access to this Creator Agent is no longer available. Refresh your Creator Agents and choose an available Agent."
      }
    });
    assert.equal(entitlementCalls, 2);
    assert.equal(boundary.runCalls(), 0);
  } finally {
    socket?.close();
    await boundary.runtime.close();
  }
});

test("Runtime admits only one client hello while Registry authorization is pending", async () => {
  const entitlement = testEntitlement();
  let identityCalls = 0;
  let markIdentityStarted: (() => void) | undefined;
  let releaseIdentity: ((identity: { sub: string; role: "user" }) => void) | undefined;
  const identityStarted = new Promise<void>((resolve) => { markIdentityStarted = resolve; });
  const pendingIdentity = new Promise<{ sub: string; role: "user" }>((resolve) => {
    releaseIdentity = resolve;
  });
  const identityResolver: AuthIdentityResolver = {
    resolveIdentity: async () => {
      identityCalls += 1;
      markIdentityStarted?.();
      return pendingIdentity;
    }
  };
  const entitlementResolver: EntitlementResolver = {
    list: async () => [entitlement],
    resolve: async () => entitlement
  };
  const boundary = await startBoundaryRuntime(entitlement, {
    authIdentityResolver: identityResolver,
    entitlementResolver
  });
  const socket = new WebSocket(`ws://127.0.0.1:${boundary.port}/runtime`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const hello = {
      type: "client.hello",
      protocol_version: "0.6",
      installation_id: "desktop-concurrent-hello",
      auth_token: "opaque-user-session",
      entitlement_id: entitlement.entitlement_id,
      creator_id: entitlement.creator_id,
      agent_id: entitlement.agent_id,
      local_tools: []
    };
    socket.send(JSON.stringify(hello));
    await identityStarted;

    const duplicateFailure = waitForSocketMessage(
      socket,
      (message) => (message.error as { code?: string } | undefined)?.code === "duplicate_hello"
    );
    socket.send(JSON.stringify({ ...hello, installation_id: "desktop-concurrent-hello-2" }));
    assert.equal((await duplicateFailure).type, "turn.failed");
    assert.equal(identityCalls, 1);

    const readyResponse = waitForSocketMessage(socket, (message) => message.type === "session.ready");
    releaseIdentity?.({ sub: entitlement.user_id, role: "user" });
    assert.equal((await readyResponse).type, "session.ready");
    assert.equal(identityCalls, 1);
  } finally {
    releaseIdentity?.({ sub: entitlement.user_id, role: "user" });
    socket.close();
    await boundary.runtime.close();
  }
});

test("Runtime reserves connection and conversation slots before Registry awaits", async () => {
  const entitlement = testEntitlement();
  let identityCalls = 0;
  let releasePendingIdentity: ((identity: { sub: string; role: "user" } | undefined) => void) | undefined;
  let markPendingStarted: (() => void) | undefined;
  const pendingStarted = new Promise<void>((resolve) => { markPendingStarted = resolve; });
  const pendingIdentity = new Promise<{ sub: string; role: "user" } | undefined>((resolve) => {
    releasePendingIdentity = resolve;
  });
  const identityResolver: AuthIdentityResolver = {
    resolveIdentity: async () => {
      identityCalls += 1;
      if (identityCalls <= 2) return { sub: entitlement.user_id, role: "user" };
      if (identityCalls === 3) {
        markPendingStarted?.();
        return pendingIdentity;
      }
      return undefined;
    }
  };
  const entitlementResolver: EntitlementResolver = {
    list: async () => [entitlement],
    resolve: async () => entitlement
  };
  const boundary = await startBoundaryRuntime(entitlement, {
    authIdentityResolver: identityResolver,
    entitlementResolver
  });
  let firstSocket: WebSocket | undefined;
  let secondSocket: WebSocket | undefined;
  try {
    firstSocket = await connectAuthorizedSocket(boundary.port, entitlement);
    secondSocket = await connectAuthorizedSocket(boundary.port, entitlement);

    const firstFailure = waitForSocketMessage(firstSocket, (message) => message.run_id === "run-pending-first");
    firstSocket.send(JSON.stringify(clientMessage("run-pending-first", "conversation-shared")));
    await pendingStarted;

    const connectionBusy = waitForSocketMessage(firstSocket, (message) => message.run_id === "run-pending-same-socket");
    firstSocket.send(JSON.stringify(clientMessage("run-pending-same-socket", "conversation-other")));
    const conversationBusy = waitForSocketMessage(secondSocket, (message) => message.run_id === "run-pending-same-conversation");
    secondSocket.send(JSON.stringify(clientMessage("run-pending-same-conversation", "conversation-shared")));

    assert.equal(((await connectionBusy).error as { code?: string }).code, "connection_busy");
    assert.equal(((await conversationBusy).error as { code?: string }).code, "conversation_busy");
    assert.equal(identityCalls, 3);
    assert.equal(boundary.runCalls(), 0);

    releasePendingIdentity?.(undefined);
    assert.equal(((await firstFailure).error as { code?: string }).code, "authentication_required");
  } finally {
    releasePendingIdentity?.(undefined);
    firstSocket?.close();
    secondSocket?.close();
    await boundary.runtime.close();
  }
});

test("Runtime turns a Registry authorization timeout into a controlled unavailable failure", async () => {
  const entitlement = testEntitlement();
  let identityCalls = 0;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/v1/auth/me") {
      identityCalls += 1;
      if (identityCalls === 1) {
        return new Response(JSON.stringify({ id: entitlement.user_id, role: "user" }), { status: 200 });
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return new Response(JSON.stringify([entitlement]), { status: 200 });
  };
  const registryResolver = new RegistryEntitlementResolver(
    "https://registry.example.test",
    fetchImpl,
    { timeoutMs: 25 }
  );
  const boundary = await startBoundaryRuntime(entitlement, {
    authIdentityResolver: registryResolver,
    entitlementResolver: registryResolver
  });
  let socket: WebSocket | undefined;
  try {
    socket = await connectAuthorizedSocket(boundary.port, entitlement);
    const failedResponse = nextSocketMessage(socket);
    socket.send(JSON.stringify(clientMessage("run-registry-timeout")));
    assert.deepEqual(await failedResponse, {
      type: "turn.failed",
      run_id: "run-registry-timeout",
      error: {
        code: "authorization_unavailable",
        message: "Hatch could not verify access for this turn. Check your connection and try again."
      }
    });
    assert.equal(identityCalls, 2);
    assert.equal(boundary.runCalls(), 0);
  } finally {
    socket?.close();
    await boundary.runtime.close();
  }
});

test("closing a Runtime socket aborts its pending Registry authorization request", async () => {
  const entitlement = testEntitlement();
  let identityCalls = 0;
  let markPendingStarted: (() => void) | undefined;
  let markAbortObserved: (() => void) | undefined;
  const pendingStarted = new Promise<void>((resolve) => { markPendingStarted = resolve; });
  const abortObserved = new Promise<void>((resolve) => { markAbortObserved = resolve; });
  const identityResolver: AuthIdentityResolver = {
    resolveIdentity: async (_token, options) => {
      identityCalls += 1;
      if (identityCalls === 1) return { sub: entitlement.user_id, role: "user" };
      markPendingStarted?.();
      return new Promise((_resolve, reject) => {
        const signal = options?.signal;
        const abort = () => {
          markAbortObserved?.();
          reject(new EntitlementError("authorization_cancelled", "socket closed"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
  };
  const entitlementResolver: EntitlementResolver = {
    list: async () => [entitlement],
    resolve: async () => entitlement
  };
  const boundary = await startBoundaryRuntime(entitlement, {
    authIdentityResolver: identityResolver,
    entitlementResolver
  });
  const socket = await connectAuthorizedSocket(boundary.port, entitlement);
  try {
    socket.send(JSON.stringify(clientMessage("run-close-cancels-auth")));
    await pendingStarted;
    socket.close();
    await abortObserved;
    assert.equal(boundary.runCalls(), 0);
  } finally {
    socket.close();
    await boundary.runtime.close();
  }
});

function testEntitlement(): EntitlementBinding {
  return {
    entitlement_id: "ent_jordan_resume",
    order_id: "order_jordan_resume",
    user_id: "user_jordan",
    creator_id: "creator_maya",
    product_id: "product_resume",
    agent_id: "agent_resume",
    status: "active"
  };
}

async function startBoundaryRuntime(
  entitlement: EntitlementBinding,
  authorization: {
    authIdentityResolver?: AuthIdentityResolver;
    entitlementResolver: EntitlementResolver;
  }
): Promise<{ runtime: RuntimeServer; port: number; runCalls: () => number }> {
  const corpus = revocableTestCorpus(entitlement);
  const agentCorpusResolver = {
    resolve: async () => ({
      root: "/tmp/hatch-runtime-pending-auth-boundary",
      corpus,
      digest: `sha256:${"3".repeat(64)}`
    })
  } as unknown as AgentCorpusResolver;
  let calls = 0;
  const agentRuntime: AgentRuntime = {
    async *run(input) {
      calls += 1;
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  };
  const runtime = createRuntimeServer({
    createRuntime: () => agentRuntime,
    authIdentityResolver: authorization.authIdentityResolver,
    entitlementResolver: authorization.entitlementResolver,
    agentCorpusResolver
  });
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  return { runtime, port: address.port, runCalls: () => calls };
}

type RevocableRegistryState = {
  sessionActive: boolean;
  entitlementActive: boolean;
};

async function createRevocableRuntimeScenario(): Promise<{
  entitlement: EntitlementBinding;
  registryState: RevocableRegistryState;
  registryCalls: { identity: number; access: number };
  runtimePort: number;
  runCalls: () => number;
  socket?: WebSocket;
  close: () => Promise<void>;
}> {
  const entitlement: EntitlementBinding = {
    entitlement_id: "ent_jordan_resume",
    order_id: "order_jordan_resume",
    user_id: "user_jordan",
    creator_id: "creator_maya",
    product_id: "product_resume",
    agent_id: "agent_resume",
    status: "active"
  };
  const registryState: RevocableRegistryState = {
    sessionActive: true,
    entitlementActive: true
  };
  const registryCalls = { identity: 0, access: 0 };
  const registry = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/auth/me") {
      registryCalls.identity += 1;
      if (!registryState.sessionActive) {
        response.writeHead(401);
        response.end(JSON.stringify({ detail: "A valid account token is required." }));
        return;
      }
      response.end(JSON.stringify({
        id: entitlement.user_id,
        role: "user",
        session_expires_at: new Date(Date.now() + 3_600_000).toISOString()
      }));
      return;
    }
    if (new URL(request.url ?? "/", "http://registry.test").pathname === "/v1/user/agent-access") {
      registryCalls.access += 1;
      if (!registryState.sessionActive) {
        response.writeHead(401);
        response.end(JSON.stringify({ detail: "A valid account token is required." }));
        return;
      }
      response.end(JSON.stringify(registryState.entitlementActive ? [entitlement] : []));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ detail: "not found" }));
  });
  await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
  const registryAddress = registry.address();
  assert.ok(registryAddress && typeof registryAddress !== "string");

  const registryResolver = new RegistryEntitlementResolver(`http://127.0.0.1:${registryAddress.port}`);
  const corpus = revocableTestCorpus(entitlement);
  const agentCorpusResolver = {
    resolve: async () => ({
      root: "/tmp/hatch-runtime-revocable-auth-boundary",
      corpus,
      digest: `sha256:${"1".repeat(64)}`
    })
  } as unknown as AgentCorpusResolver;
  let runtimeRunCalls = 0;
  const agentRuntime: AgentRuntime = {
    async *run() {
      runtimeRunCalls += 1;
      yield {
        type: "turn.completed",
        run_id: "unexpected-run",
        finish_reason: "stop"
      };
    }
  };
  const runtime = createRuntimeServer({
    createRuntime: () => agentRuntime,
    authIdentityResolver: registryResolver,
    entitlementResolver: registryResolver,
    agentCorpusResolver
  });
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const runtimeAddress = runtime.server.address();
  assert.ok(runtimeAddress && typeof runtimeAddress !== "string");

  const scenario: {
    entitlement: EntitlementBinding;
    registryState: RevocableRegistryState;
    registryCalls: { identity: number; access: number };
    runtimePort: number;
    runCalls: () => number;
    socket?: WebSocket;
    close: () => Promise<void>;
  } = {
    entitlement,
    registryState,
    registryCalls,
    runtimePort: runtimeAddress.port,
    runCalls: () => runtimeRunCalls,
    close: async () => {
      scenario.socket?.close();
      await runtime.close();
      await new Promise<void>((resolve, reject) => registry.close((error) => error ? reject(error) : resolve()));
    }
  };
  return scenario;
}

function revocableTestCorpus(entitlement: EntitlementBinding): AgentCorpus {
  return {
    agent_id: entitlement.agent_id,
    creator: { id: entitlement.creator_id, name: "Maya" },
    product: {
      id: entitlement.product_id,
      name: "Resume Review",
      boundaries: [],
      presentation: {}
    },
    knowledge: { documents: [] },
    tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }]
  } as unknown as AgentCorpus;
}

async function connectAuthorizedSocket(runtimePort: number, entitlement: EntitlementBinding): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${runtimePort}/runtime`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const response = nextSocketMessage(socket);
  socket.send(JSON.stringify({
    type: "client.hello",
    protocol_version: "0.6",
    installation_id: "desktop-jordan",
    auth_token: "opaque-user-session",
    entitlement_id: entitlement.entitlement_id,
    creator_id: entitlement.creator_id,
    agent_id: entitlement.agent_id,
    local_tools: []
  }));
  const ready = await response;
  assert.equal(ready.type, "session.ready");
  return socket;
}

function clientMessage(
  runId: string,
  conversationId = "conversation-revocable-access"
): Record<string, unknown> {
  return {
    type: "client.message",
    run_id: runId,
    conversation_id: conversationId,
    message: { role: "user", content: "Review this." }
  };
}

function nextSocketMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}

function waitForSocketMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
}
