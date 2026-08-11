import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { AgentCorpusResolver, type AgentCorpus } from "./agentCorpus.js";
import type { AgentRuntime, RunContext } from "./agentRuntime.js";
import { authTrustedProxyPolicyFromEnvironment } from "./authRateLimit.js";
import { creatorModelToolName, type CreatorToolControlPlane } from "./creatorTools.js";
import {
  EntitlementError,
  type AuthIdentityResolver,
  type EntitlementBinding,
  type EntitlementResolver
} from "./entitlements.js";
import {
  MAX_RUNTIME_WEBSOCKET_PAYLOAD_BYTES,
  createRuntimeServer,
  createRuntimeServerFromEnvironment,
  type RuntimeServer
} from "./index.js";
import { RuntimeStore } from "./store.js";
import { PiAgentRuntime } from "./piAgentRuntime.js";
import { runPiAgentPrompt } from "./piPrompt.js";
import type { RunStart } from "./protocol.js";

test("pre-aborted Pi entry points never start a provider prompt", async () => {
  const controller = new AbortController();
  const reason = new Error("run was already cancelled");
  controller.abort(reason);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("provider must not be called");
  }) as typeof globalThis.fetch;
  try {
    await assert.rejects(
      runPiAgentPrompt({ prompt: "must not run", signal: controller.signal }),
      (error) => error === reason
    );

    const runtime = new PiAgentRuntime();
    const input = clientMessage("pre-aborted-run", "pre-aborted-conversation") as RunStart;
    await assert.rejects(async () => {
      for await (const _event of runtime.run(input, {
        abortSignal: controller.signal
      } as unknown as RunContext)) {
        // No event may be produced by a pre-aborted run.
      }
    }, (error) => error === reason);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy HMAC auth is inert by default and uses only an explicit Runtime environment", async () => {
  const originalGlobalSecret = process.env.HATCH_AUTH_SIGNING_SECRET;
  process.env.HATCH_AUTH_SIGNING_SECRET = "unrelated-global-secret";
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-legacy-gate-"));
  const explicitSecret = "explicit-fixture-secret";
  const token = signLegacyToken(explicitSecret, "legacy-user");
  let disabled: RuntimeServer | undefined;
  let enabled: RuntimeServer | undefined;
  let disabledSocket: WebSocket | undefined;
  let enabledSocket: WebSocket | undefined;
  try {
    disabled = await createRuntimeServerFromEnvironment({
      HATCH_AUTH_SIGNING_SECRET: explicitSecret,
      HATCH_RUNTIME_DATA_DIR: path.join(root, "disabled")
    });
    const disabledPort = await listen(disabled);
    disabledSocket = await openSocket(disabledPort);
    const disabledReady = waitForMessage(disabledSocket, (message) => message.type === "session.ready");
    disabledSocket.send(JSON.stringify(hello(token, "legacy-install-disabled")));
    assert.equal((await disabledReady).user_id, "legacy-install-disabled");

    enabled = await createRuntimeServerFromEnvironment({
      HATCH_ENABLE_LEGACY_HMAC_AUTH: "true",
      HATCH_AUTH_SIGNING_SECRET: explicitSecret,
      HATCH_RUNTIME_DATA_DIR: path.join(root, "enabled")
    });
    const enabledPort = await listen(enabled);
    enabledSocket = await openSocket(enabledPort);
    const enabledReady = waitForMessage(enabledSocket, (message) => message.type === "session.ready");
    enabledSocket.send(JSON.stringify(hello(token, "legacy-install-enabled")));
    assert.equal((await enabledReady).user_id, "legacy-user");

    await assert.rejects(
      createRuntimeServerFromEnvironment({ HATCH_ENABLE_LEGACY_HMAC_AUTH: "true" }),
      /HATCH_AUTH_SIGNING_SECRET/
    );
    assert.throws(
      () => createRuntimeServer({ enableLegacyHmacAuth: true }),
      /legacyHmacSecret/
    );
  } finally {
    disabledSocket?.close();
    enabledSocket?.close();
    if (disabled) await disabled.close();
    if (enabled) await enabled.close();
    if (originalGlobalSecret === undefined) delete process.env.HATCH_AUTH_SIGNING_SECRET;
    else process.env.HATCH_AUTH_SIGNING_SECRET = originalGlobalSecret;
  }
});

test("environment Runtime refuses resolver-free non-loopback exposure", async () => {
  await assert.rejects(
    createRuntimeServerFromEnvironment({ HATCH_RUNTIME_HOST: "0.0.0.0" }),
    /non-loopback Runtime requires/
  );
  await assert.rejects(
    createRuntimeServerFromEnvironment({ HATCH_REGISTRY_URL: "file:///tmp/not-a-registry" }),
    /http or https/
  );
  await assert.rejects(
    createRuntimeServerFromEnvironment({
      HATCH_RUNTIME_HOST: "0.0.0.0",
      HATCH_REGISTRY_URL: "http://registry.invalid",
      HATCH_AGENT_CORPUS_ROOT: "/srv/hatch/corpora"
    }),
    /HATCH_RUNTIME_DATABASE_URL/
  );
});

test("environment Runtime never treats the Registry database secret as its conversation store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-db-isolation-"));
  const runtime = await createRuntimeServerFromEnvironment({
    HATCH_REGISTRY_DATABASE_URL: "postgres://registry-only.invalid/registry",
    HATCH_RUNTIME_DATA_DIR: root
  });
  const port = await listen(runtime);
  const socket = await openSocket(port);
  try {
    const ready = waitForMessage(socket, (message) => message.type === "session.ready");
    socket.send(JSON.stringify(hello("fixture-token", "database-isolation-install")));
    assert.equal((await ready).type, "session.ready");
  } finally {
    socket.close();
    await runtime.close();
  }
});

test("unauthenticated WebSocket is terminated when the client hello deadline expires", async () => {
  let storeClosed = false;
  const store = {
    close: async () => { storeClosed = true; }
  } as unknown as RuntimeStore;
  const runtime = createRuntimeServer({
    conversationStore: store,
    clientHelloTimeoutMs: 25
  });
  const port = await listen(runtime);
  const socket = await openSocket(port);
  socket.on("error", () => undefined);
  let runtimeClosed = false;
  try {
    const closeCode = await new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    assert.equal(closeCode, 1006);
    assert.equal(await Promise.race([
      runtime.close().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))
    ]), true);
    runtimeClosed = true;
    assert.equal(storeClosed, true);
  } finally {
    socket.close();
    if (!runtimeClosed) await runtime.close();
  }
});

test("global open-socket capacity bounds silent pre-hello clients and releases on close", async () => {
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-open-capacity-"))),
    clientHelloTimeoutMs: 2_000,
    maxOpenConnectionsGlobal: 2
  });
  const port = await listen(runtime);
  const first = await openSocket(port);
  const second = await openSocket(port);
  let overflow: WebSocket | undefined;
  let admitted: WebSocket | undefined;
  try {
    overflow = new WebSocket(`ws://127.0.0.1:${port}/runtime`);
    overflow.on("error", () => undefined);
    assert.equal(await Promise.race([
      new Promise<boolean>((resolve) => overflow!.once("close", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))
    ]), true);

    const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()));
    first.close();
    await firstClosed;
    admitted = await openSocket(port);
    const ready = waitForMessage(admitted, (message) => message.type === "session.ready");
    admitted.send(JSON.stringify(hello("open-capacity-admitted", "open-capacity-user")));
    await ready;
  } finally {
    first.close();
    second.close();
    overflow?.close();
    admitted?.close();
    await runtime.close();
  }
});

test("per-source open-socket capacity prevents one proxy client from starving another", async () => {
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-source-open-capacity-"))),
    clientHelloTimeoutMs: 2_000,
    maxOpenConnectionsGlobal: 2,
    maxOpenConnectionsPerSource: 1,
    trustedProxyPolicy: authTrustedProxyPolicyFromEnvironment({
      HATCH_AUTH_TRUSTED_PROXY_CIDRS: "127.0.0.1/32"
    })
  });
  const port = await listen(runtime);
  const first = await openSocket(port, { "x-forwarded-for": "203.0.113.10" });
  const overflow = new WebSocket(`ws://127.0.0.1:${port}/runtime`, {
    headers: { "x-forwarded-for": "203.0.113.10" }
  });
  overflow.on("error", () => undefined);
  let otherSource: WebSocket | undefined;
  let replacement: WebSocket | undefined;
  try {
    assert.equal(await Promise.race([
      new Promise<boolean>((resolve) => overflow.once("close", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))
    ]), true);
    otherSource = await openSocket(port, { "x-forwarded-for": "203.0.113.11" });

    const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()));
    first.close();
    await firstClosed;
    replacement = await openSocket(port, { "x-forwarded-for": "203.0.113.10" });
  } finally {
    first.close();
    overflow.close();
    otherSource?.close();
    replacement?.close();
    await runtime.close();
  }
});

test("global hello authorization capacity rejects N+1 without calling the resolver and releases reliably", async () => {
  const resolverCalls: string[] = [];
  const releases: Array<(identity: undefined) => void> = [];
  const authIdentityResolver: AuthIdentityResolver = {
    resolveIdentity: async (token) => {
      resolverCalls.push(token ?? "");
      return new Promise<undefined>((resolve) => releases.push(resolve));
    }
  };
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-hello-capacity-"))),
    authIdentityResolver,
    clientHelloTimeoutMs: 2_000,
    maxPendingHelloAuthorizations: 2
  });
  const port = await listen(runtime);
  const sockets: WebSocket[] = [];
  try {
    for (const index of [1, 2]) {
      const socket = await openSocket(port);
      sockets.push(socket);
      socket.send(JSON.stringify(hello(`pending-session-${index}`, `pending-install-${index}`)));
    }
    await waitUntil(() => resolverCalls.length === 2);

    const overflow = await openSocket(port);
    sockets.push(overflow);
    const rejected = waitForMessage(overflow, (message) => (message.error as { code?: string } | undefined)?.code === "authentication_busy");
    overflow.send(JSON.stringify(hello("overflow-session", "overflow-install")));
    assert.equal(((await rejected).error as { code?: string }).code, "authentication_busy");
    assert.equal(resolverCalls.length, 2);

    const firstRejected = waitForMessage(sockets[0]!, (message) => (message.error as { code?: string } | undefined)?.code === "authentication_required");
    releases[0]?.(undefined);
    await firstRejected;

    const admitted = await openSocket(port);
    sockets.push(admitted);
    admitted.send(JSON.stringify(hello("admitted-session", "admitted-install")));
    await waitUntil(() => resolverCalls.length === 3);
    assert.deepEqual(resolverCalls, ["pending-session-1", "pending-session-2", "admitted-session"]);
  } finally {
    for (const release of releases) release(undefined);
    for (const socket of sockets) socket.close();
    await runtime.close();
  }
});

test("per-user hello capacity is acquired after identity but before Agent Corpus resolution", async () => {
  const entitlement = fixtureEntitlement();
  const resolvedCorpus = await fixtureCorpusResolver(entitlement).resolve(entitlement.creator_id, entitlement.agent_id);
  let corpusCalls = 0;
  let markCorpusStarted!: () => void;
  const corpusStarted = new Promise<void>((resolve) => { markCorpusStarted = resolve; });
  let releaseCorpus!: () => void;
  const corpusGate = new Promise<void>((resolve) => { releaseCorpus = resolve; });
  const corpusResolver = {
    resolve: async () => {
      corpusCalls += 1;
      markCorpusStarted();
      await corpusGate;
      return resolvedCorpus;
    }
  } as unknown as AgentCorpusResolver;
  const identityResolver: AuthIdentityResolver = {
    resolveIdentity: async () => ({ sub: entitlement.user_id, role: "user" })
  };
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-user-hello-capacity-"))),
    authIdentityResolver: identityResolver,
    entitlementResolver: fixtureEntitlementResolver(entitlement),
    agentCorpusResolver: corpusResolver,
    maxPendingHelloAuthorizations: 4,
    maxPendingHelloAuthorizationsPerUser: 1
  });
  const port = await listen(runtime);
  const first = await openSocket(port);
  const second = await openSocket(port);
  try {
    const firstReady = waitForMessage(first, (message) => message.type === "session.ready");
    first.send(JSON.stringify({
      ...hello("same-user-session-one", "same-user-install-one"),
      entitlement_id: entitlement.entitlement_id,
      creator_id: entitlement.creator_id,
      agent_id: entitlement.agent_id
    }));
    await corpusStarted;

    const rejected = waitForMessage(second, (message) => (message.error as { code?: string } | undefined)?.code === "user_authentication_busy");
    second.send(JSON.stringify({
      ...hello("same-user-session-two", "same-user-install-two"),
      entitlement_id: entitlement.entitlement_id,
      creator_id: entitlement.creator_id,
      agent_id: entitlement.agent_id
    }));
    assert.equal(((await rejected).error as { code?: string }).code, "user_authentication_busy");
    assert.equal(corpusCalls, 1);

    releaseCorpus();
    await firstReady;
  } finally {
    releaseCorpus();
    first.close();
    second.close();
    await runtime.close();
  }
});

test("hello setup keeps its admission lease and aborts Creator tool resolution on close", async () => {
  const entitlement = fixtureEntitlement();
  const corpus = fixtureCreatorToolCorpus(entitlement);
  let setupSignal: AbortSignal | undefined;
  let markSetupStarted!: () => void;
  const setupStarted = new Promise<void>((resolve) => { markSetupStarted = resolve; });
  const controlPlane: CreatorToolControlPlane = {
    resolve: async (request) => {
      setupSignal = request.signal;
      markSetupStarted();
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
      });
    }
  };
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-creator-hello-abort-"))),
    authIdentityResolver: { resolveIdentity: async () => ({ sub: entitlement.user_id, role: "user" }) },
    entitlementResolver: fixtureEntitlementResolver(entitlement),
    agentCorpusResolver: {
      resolve: async () => ({ root: "/fixture-corpus", corpus, digest: `sha256:${"1".repeat(64)}` })
    } as unknown as AgentCorpusResolver,
    creatorToolControlPlane: controlPlane,
    maxPendingHelloAuthorizations: 1,
    clientHelloTimeoutMs: 2_000
  });
  const port = await listen(runtime);
  const first = await openSocket(port);
  let overflow: WebSocket | undefined;
  try {
    first.send(JSON.stringify({
      ...hello("creator-setup-one", "creator-setup-install-one"),
      entitlement_id: entitlement.entitlement_id,
      creator_id: entitlement.creator_id,
      agent_id: entitlement.agent_id
    }));
    await setupStarted;

    overflow = await openSocket(port);
    const rejected = waitForMessage(overflow, (message) => (message.error as { code?: string } | undefined)?.code === "authentication_busy");
    overflow.send(JSON.stringify({
      ...hello("creator-setup-two", "creator-setup-install-two"),
      entitlement_id: entitlement.entitlement_id,
      creator_id: entitlement.creator_id,
      agent_id: entitlement.agent_id
    }));
    assert.equal(((await rejected).error as { code?: string }).code, "authentication_busy");

    const closed = new Promise<void>((resolve) => first.once("close", () => resolve()));
    first.close();
    await closed;
    await waitUntil(() => setupSignal?.aborted === true);
  } finally {
    first.close();
    overflow?.close();
    await runtime.close();
  }
});

test("an existing session re-resolves Creator tool bindings and blocks a disabled binding before model work", async () => {
  const entitlement = fixtureEntitlement();
  const corpus = fixtureCreatorToolCorpus(entitlement);
  let resolutionCalls = 0;
  const controlPlane: CreatorToolControlPlane = {
    resolve: async (request) => {
      resolutionCalls += 1;
      if (resolutionCalls > 1) throw new Error("binding disabled");
      assert.equal(request.tool.kind, "http_function");
      if (request.tool.kind !== "http_function") throw new Error("unexpected tool kind");
      return [{
        id: request.tool.id,
        modelName: creatorModelToolName(request.tool.id),
        kind: "http",
        connectionRef: request.tool.connection_ref,
        function: {
          name: request.tool.operation,
          description: request.tool.description ?? "fixture",
          parameters: request.tool.input_schema ?? {}
        },
        execute: async () => ({ version: 1 })
      }];
    }
  };
  let runCalls = 0;
  const runtime = createRuntimeServer({
    createRuntime: () => completingRuntime(() => { runCalls += 1; }),
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-creator-refresh-"))),
    authIdentityResolver: { resolveIdentity: async () => ({ sub: entitlement.user_id, role: "user" }) },
    entitlementResolver: fixtureEntitlementResolver(entitlement),
    agentCorpusResolver: {
      resolve: async () => ({ root: "/fixture-corpus", corpus, digest: `sha256:${"1".repeat(64)}` })
    } as unknown as AgentCorpusResolver,
    creatorToolControlPlane: controlPlane
  });
  const port = await listen(runtime);
  const socket = await connectEntitledSocket(port, entitlement, "creator-refresh-session", "creator-refresh-install");
  try {
    const rejected = waitForMessage(socket, (message) => message.run_id === "creator-disabled-run"
      && (message.error as { code?: string } | undefined)?.code === "agent_updated");
    socket.send(JSON.stringify(clientMessage("creator-disabled-run", "creator-disabled-conversation")));
    assert.equal(((await rejected).error as { code?: string }).code, "agent_updated");
    assert.equal(resolutionCalls, 2);
    assert.equal(runCalls, 0);
  } finally {
    socket.close();
    await runtime.close();
  }
});

test("an existing session uses a rotated Creator tool binding on its next turn", async () => {
  const entitlement = fixtureEntitlement();
  const fixture = await writeCreatorCorpusFixture(entitlement);
  let resolutionCalls = 0;
  const controlPlane: CreatorToolControlPlane = {
    resolve: async (request) => {
      resolutionCalls += 1;
      assert.equal(request.tool.kind, "http_function");
      if (request.tool.kind !== "http_function") throw new Error("unexpected tool kind");
      const version = resolutionCalls;
      return [{
        id: request.tool.id,
        modelName: creatorModelToolName(request.tool.id),
        kind: "http",
        connectionRef: request.tool.connection_ref,
        function: {
          name: request.tool.operation,
          description: request.tool.description ?? "fixture",
          parameters: request.tool.input_schema ?? {}
        },
        execute: async () => ({ credential_version: version })
      }];
    }
  };
  let observedVersion: unknown;
  const agentRuntime: AgentRuntime = {
    async *run(input, context) {
      const result = await context.serverTools.executeCreatorTool({ id: "creator.boundary.lookup" }, {}, context.abortSignal);
      observedVersion = result.credential_version;
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  };
  const runtime = createRuntimeServer({
    createRuntime: () => agentRuntime,
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-creator-rotation-store-"))),
    authIdentityResolver: { resolveIdentity: async () => ({ sub: entitlement.user_id, role: "user" }) },
    entitlementResolver: fixtureEntitlementResolver(entitlement),
    agentCorpusResolver: new AgentCorpusResolver(fixture.baseRoot),
    creatorToolControlPlane: controlPlane
  });
  const port = await listen(runtime);
  const socket = await connectEntitledSocket(port, entitlement, "creator-rotation-session", "creator-rotation-install");
  try {
    const completed = waitForMessage(socket, (message) => message.type === "turn.completed" && message.run_id === "creator-rotation-run");
    socket.send(JSON.stringify(clientMessage("creator-rotation-run", "creator-rotation-conversation")));
    await completed;
    assert.equal(resolutionCalls, 2);
    assert.equal(observedVersion, 2);
  } finally {
    socket.close();
    await runtime.close();
    await rm(fixture.baseRoot, { recursive: true, force: true });
  }
});

test("global per-turn authorization capacity rejects N+1 without another Registry call", async () => {
  const entitlement = fixtureEntitlement();
  const tokenCalls = new Map<string, number>();
  const pendingReleases: Array<(identity: { sub: string; role: "user" }) => void> = [];
  const identityResolver: AuthIdentityResolver = {
    resolveIdentity: async (token) => {
      const calls = (tokenCalls.get(token ?? "") ?? 0) + 1;
      tokenCalls.set(token ?? "", calls);
      if (calls === 1) return { sub: entitlement.user_id, role: "user" };
      return new Promise<{ sub: string; role: "user" }>((resolve) => pendingReleases.push(resolve));
    }
  };
  let runCalls = 0;
  const runtime = createRuntimeServer({
    createRuntime: () => completingRuntime(() => { runCalls += 1; }),
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-turn-auth-capacity-"))),
    authIdentityResolver: identityResolver,
    entitlementResolver: fixtureEntitlementResolver(entitlement),
    agentCorpusResolver: fixtureCorpusResolver(entitlement),
    maxPendingTurnAuthorizations: 2,
    maxActiveRunsGlobal: 10,
    maxActiveRunsPerUser: 10
  });
  const port = await listen(runtime);
  const sockets: WebSocket[] = [];
  try {
    for (const index of [1, 2, 3]) {
      sockets.push(await connectEntitledSocket(
        port,
        entitlement,
        `turn-session-${index}`,
        `turn-install-${index}`
      ));
    }
    sockets[0]!.send(JSON.stringify(clientMessage("turn-capacity-one", "turn-conversation-one")));
    sockets[1]!.send(JSON.stringify(clientMessage("turn-capacity-two", "turn-conversation-two")));
    await waitUntil(() => pendingReleases.length === 2);

    const rejected = waitForMessage(sockets[2]!, (message) => message.run_id === "turn-capacity-overflow"
      && (message.error as { code?: string } | undefined)?.code === "authorization_busy");
    sockets[2]!.send(JSON.stringify(clientMessage("turn-capacity-overflow", "turn-conversation-three")));
    assert.equal(((await rejected).error as { code?: string }).code, "authorization_busy");
    assert.equal([...tokenCalls.values()].reduce((sum, calls) => sum + calls, 0), 5);
    assert.equal(runCalls, 0);

    const firstCompleted = waitForMessage(sockets[0]!, (message) => message.type === "turn.completed" && message.run_id === "turn-capacity-one");
    pendingReleases[0]?.({ sub: entitlement.user_id, role: "user" });
    await firstCompleted;

    sockets[2]!.send(JSON.stringify(clientMessage("turn-capacity-admitted", "turn-conversation-three")));
    await waitUntil(() => pendingReleases.length === 3);
    assert.equal(tokenCalls.get("turn-session-3"), 2);
  } finally {
    for (const release of pendingReleases) release({ sub: entitlement.user_id, role: "user" });
    for (const socket of sockets) socket.close();
    await runtime.close();
  }
});

test("per-user turn authorization capacity prevents one account from occupying the global gate", async () => {
  const entitlement = fixtureEntitlement();
  const tokenCalls = new Map<string, number>();
  let markPendingStarted!: () => void;
  const pendingStarted = new Promise<void>((resolve) => { markPendingStarted = resolve; });
  let releasePending!: (identity: { sub: string; role: "user" }) => void;
  const pendingIdentity = new Promise<{ sub: string; role: "user" }>((resolve) => { releasePending = resolve; });
  const identityResolver: AuthIdentityResolver = {
    resolveIdentity: async (token) => {
      const calls = (tokenCalls.get(token ?? "") ?? 0) + 1;
      tokenCalls.set(token ?? "", calls);
      if (token === "fair-user-one" && calls === 2) {
        markPendingStarted();
        return pendingIdentity;
      }
      return { sub: entitlement.user_id, role: "user" };
    }
  };
  let runCalls = 0;
  const runtime = createRuntimeServer({
    createRuntime: () => completingRuntime(() => { runCalls += 1; }),
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-user-auth-capacity-"))),
    authIdentityResolver: identityResolver,
    entitlementResolver: fixtureEntitlementResolver(entitlement),
    agentCorpusResolver: fixtureCorpusResolver(entitlement),
    maxPendingTurnAuthorizations: 4,
    maxPendingTurnAuthorizationsPerUser: 1,
    maxActiveRunsPerUser: 4
  });
  const port = await listen(runtime);
  let first: WebSocket | undefined;
  let second: WebSocket | undefined;
  try {
    first = await connectEntitledSocket(port, entitlement, "fair-user-one", "fair-user-install-one");
    second = await connectEntitledSocket(port, entitlement, "fair-user-two", "fair-user-install-two");
    first.send(JSON.stringify(clientMessage("fair-auth-first", "fair-auth-conversation-first")));
    await pendingStarted;

    const rejected = waitForMessage(second, (message) => message.run_id === "fair-auth-overflow"
      && (message.error as { code?: string } | undefined)?.code === "user_authorization_busy");
    second.send(JSON.stringify(clientMessage("fair-auth-overflow", "fair-auth-conversation-overflow")));
    assert.equal(((await rejected).error as { code?: string }).code, "user_authorization_busy");
    assert.equal(tokenCalls.get("fair-user-two"), 1);
    assert.equal(runCalls, 0);

    const firstCompleted = waitForMessage(first, (message) => message.type === "turn.completed" && message.run_id === "fair-auth-first");
    releasePending({ sub: entitlement.user_id, role: "user" });
    await firstCompleted;
    const secondCompleted = waitForMessage(second, (message) => message.type === "turn.completed" && message.run_id === "fair-auth-admitted");
    second.send(JSON.stringify(clientMessage("fair-auth-admitted", "fair-auth-conversation-admitted")));
    await secondCompleted;
    assert.equal(tokenCalls.get("fair-user-two"), 2);
  } finally {
    releasePending({ sub: entitlement.user_id, role: "user" });
    first?.close();
    second?.close();
    await runtime.close();
  }
});

test("per-connection and global active-run capacity reject excess model work and release on completion", async () => {
  let runCalls = 0;
  const runReleases: Array<() => void> = [];
  const agentRuntime: AgentRuntime = {
    async *run(input) {
      runCalls += 1;
      await new Promise<void>((resolve) => runReleases.push(resolve));
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  };
  const runtime = createRuntimeServer({
    createRuntime: () => agentRuntime,
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-active-capacity-"))),
    maxActiveRunsPerConnection: 1,
    maxActiveRunsGlobal: 2
  });
  const port = await listen(runtime);
  const sockets = [await openSocket(port), await openSocket(port), await openSocket(port)];
  try {
    for (const [index, socket] of sockets.entries()) {
      const ready = waitForMessage(socket, (message) => message.type === "session.ready");
      socket.send(JSON.stringify(hello(`active-token-${index}`, `active-install-${index}`)));
      await ready;
    }

    sockets[0]!.send(JSON.stringify(clientMessage("active-one", "active-conversation-one")));
    sockets[1]!.send(JSON.stringify(clientMessage("active-two", "active-conversation-two")));
    await waitUntil(() => runCalls === 2);

    const connectionRejected = waitForMessage(sockets[0]!, (message) => message.run_id === "active-same-connection"
      && (message.error as { code?: string } | undefined)?.code === "connection_run_capacity");
    sockets[0]!.send(JSON.stringify(clientMessage("active-same-connection", "active-conversation-extra")));
    assert.equal(((await connectionRejected).error as { code?: string }).code, "connection_run_capacity");

    const globalRejected = waitForMessage(sockets[2]!, (message) => message.run_id === "active-global-overflow"
      && (message.error as { code?: string } | undefined)?.code === "runtime_run_capacity");
    sockets[2]!.send(JSON.stringify(clientMessage("active-global-overflow", "active-conversation-three")));
    assert.equal(((await globalRejected).error as { code?: string }).code, "runtime_run_capacity");
    assert.equal(runCalls, 2);

    const firstCompleted = waitForMessage(sockets[0]!, (message) => message.type === "turn.completed" && message.run_id === "active-one");
    const firstStateCompleted = waitForMessage(sockets[0]!, (message) => message.type === "turn.state"
      && message.run_id === "active-one" && message.status === "completed");
    runReleases[0]?.();
    await firstCompleted;
    await firstStateCompleted;
    await new Promise<void>((resolve) => setImmediate(resolve));

    sockets[2]!.send(JSON.stringify(clientMessage("active-after-release", "active-conversation-three")));
    await waitUntil(() => runCalls === 3);
  } finally {
    for (const release of runReleases) release();
    for (const socket of sockets) socket.close();
    await runtime.close();
  }
});

test("per-user active-run capacity preserves room for another account", async () => {
  let runCalls = 0;
  const runReleases: Array<() => void> = [];
  const agentRuntime: AgentRuntime = {
    async *run(input) {
      runCalls += 1;
      await new Promise<void>((resolve) => runReleases.push(resolve));
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  };
  const runtime = createRuntimeServer({
    createRuntime: () => agentRuntime,
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-user-run-capacity-"))),
    maxActiveRunsGlobal: 3,
    maxActiveRunsPerUser: 1,
    maxActiveRunsPerConnection: 1
  });
  const port = await listen(runtime);
  const first = await openSocket(port);
  const sameUser = await openSocket(port);
  const otherUser = await openSocket(port);
  try {
    for (const [socket, token, installation] of [
      [first, "fair-run-token-one", "fair-run-user"],
      [sameUser, "fair-run-token-two", "fair-run-user"],
      [otherUser, "fair-run-token-three", "fair-run-other-user"]
    ] as const) {
      const ready = waitForMessage(socket, (message) => message.type === "session.ready");
      socket.send(JSON.stringify(hello(token, installation)));
      await ready;
    }

    first.send(JSON.stringify(clientMessage("fair-run-first", "fair-run-conversation-first")));
    await waitUntil(() => runCalls === 1);
    const sameUserRejected = waitForMessage(sameUser, (message) => message.run_id === "fair-run-same-user"
      && (message.error as { code?: string } | undefined)?.code === "user_run_capacity");
    sameUser.send(JSON.stringify(clientMessage("fair-run-same-user", "fair-run-conversation-same-user")));
    assert.equal(((await sameUserRejected).error as { code?: string }).code, "user_run_capacity");

    otherUser.send(JSON.stringify(clientMessage("fair-run-other-user", "fair-run-conversation-other-user")));
    await waitUntil(() => runCalls === 2);
  } finally {
    for (const release of runReleases) release();
    first.close();
    sameUser.close();
    otherUser.close();
    await runtime.close();
  }
});

test("socket close retains global run capacity until an abort-ignoring Runtime settles", async () => {
  let runCalls = 0;
  const runReleases: Array<() => void> = [];
  const agentRuntime: AgentRuntime = {
    async *run(input) {
      runCalls += 1;
      // Deliberately ignore the Runtime AbortSignal. Capacity must describe
      // unfinished model work, not merely the lifetime of its client socket.
      await new Promise<void>((resolve) => runReleases.push(resolve));
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  };
  const runtime = createRuntimeServer({
    createRuntime: () => agentRuntime,
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-close-capacity-"))),
    maxActiveRunsGlobal: 1
  });
  const port = await listen(runtime);
  const first = await openSocket(port);
  const second = await openSocket(port);
  try {
    for (const [index, socket] of [first, second].entries()) {
      const ready = waitForMessage(socket, (message) => message.type === "session.ready");
      socket.send(JSON.stringify(hello(`close-capacity-token-${index}`, `close-capacity-install-${index}`)));
      await ready;
    }

    first.send(JSON.stringify(clientMessage("close-capacity-first", "close-capacity-conversation-first")));
    await waitUntil(() => runCalls === 1);
    const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()));
    first.close();
    await firstClosed;

    const rejected = waitForMessage(second, (message) => message.run_id === "close-capacity-overflow"
      && (message.error as { code?: string } | undefined)?.code === "runtime_run_capacity");
    second.send(JSON.stringify(clientMessage("close-capacity-overflow", "close-capacity-conversation-overflow")));
    assert.equal(((await rejected).error as { code?: string }).code, "runtime_run_capacity");
    const conversationRejected = waitForMessage(second, (message) => message.run_id === "close-conversation-overflow"
      && (message.error as { code?: string } | undefined)?.code === "conversation_busy");
    second.send(JSON.stringify(clientMessage("close-conversation-overflow", "close-capacity-conversation-first")));
    assert.equal(((await conversationRejected).error as { code?: string }).code, "conversation_busy");
    assert.equal(runCalls, 1);
  } finally {
    for (const release of runReleases) release();
    first.close();
    second.close();
    await runtime.close();
  }
});

test("turn.cancel retains the conversation lease until an abort-ignoring Runtime settles", async () => {
  let runCalls = 0;
  let releaseFirstRun!: () => void;
  const firstRunGate = new Promise<void>((resolve) => { releaseFirstRun = resolve; });
  let markFirstSettled!: () => void;
  const firstSettled = new Promise<void>((resolve) => { markFirstSettled = resolve; });
  const agentRuntime: AgentRuntime = {
    async *run(input) {
      const call = ++runCalls;
      try {
        if (call === 1) await firstRunGate;
        yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
      } finally {
        if (call === 1) markFirstSettled();
      }
    }
  };
  const runtime = createRuntimeServer({
    createRuntime: () => agentRuntime,
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-cancel-conversation-"))),
    maxActiveRunsGlobal: 4,
    maxActiveRunsPerUser: 4
  });
  const port = await listen(runtime);
  const first = await openSocket(port);
  const second = await openSocket(port);
  try {
    for (const [index, socket] of [first, second].entries()) {
      const ready = waitForMessage(socket, (message) => message.type === "session.ready");
      socket.send(JSON.stringify(hello(`cancel-conversation-token-${index}`, `cancel-conversation-user-${index}`)));
      await ready;
    }
    first.send(JSON.stringify(clientMessage("cancel-conversation-first", "cancel-conversation-shared")));
    await waitUntil(() => runCalls === 1);
    const cancelled = waitForMessage(first, (message) => message.run_id === "cancel-conversation-first"
      && (message.error as { code?: string } | undefined)?.code === "run_cancelled");
    first.send(JSON.stringify({ type: "turn.cancel", run_id: "cancel-conversation-first" }));
    await cancelled;

    const busy = waitForMessage(second, (message) => message.run_id === "cancel-conversation-overflow"
      && (message.error as { code?: string } | undefined)?.code === "conversation_busy");
    second.send(JSON.stringify(clientMessage("cancel-conversation-overflow", "cancel-conversation-shared")));
    assert.equal(((await busy).error as { code?: string }).code, "conversation_busy");

    releaseFirstRun();
    await firstSettled;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const admitted = waitForMessage(second, (message) => message.type === "turn.completed" && message.run_id === "cancel-conversation-admitted");
    second.send(JSON.stringify(clientMessage("cancel-conversation-admitted", "cancel-conversation-shared")));
    await admitted;
    assert.equal(runCalls, 2);
  } finally {
    releaseFirstRun();
    first.close();
    second.close();
    await runtime.close();
  }
});

test("network-tool cancellation and timeout settle the run before releasing global capacity", async () => {
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.HATCH_WEB_SEARCH_PROVIDER;
  const originalUrl = process.env.HATCH_WEB_SEARCH_URL;
  const originalKey = process.env.HATCH_WEB_SEARCH_API_KEY;
  delete process.env.HATCH_WEB_SEARCH_PROVIDER;
  delete process.env.HATCH_WEB_SEARCH_API_KEY;
  process.env.HATCH_WEB_SEARCH_URL = "https://never-resolves.invalid/search";
  try {
    for (const mode of ["cancel", "timeout"] as const) {
      let fetchCalls = 0;
      globalThis.fetch = (async (_input, init) => {
        fetchCalls += 1;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          assert.ok(signal);
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }) as typeof globalThis.fetch;
      let runtimeCalls = 0;
      let markFirstSettled!: () => void;
      const firstSettled = new Promise<void>((resolve) => { markFirstSettled = resolve; });
      const agentRuntime: AgentRuntime = {
        async *run(input, context) {
          const call = ++runtimeCalls;
          try {
            await context.serverTools.execute(
              "hatch.web_search",
              { query: `${mode} bounded request`, limit: 1 },
              context.abortSignal
            );
            yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
          } finally {
            if (call === 1) markFirstSettled();
          }
        }
      };
      const runtime = createRuntimeServer({
        createRuntime: () => agentRuntime,
        conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), `hatch-runtime-tool-${mode}-`))),
        maxActiveRunsGlobal: 1,
        serverToolTimeoutMs: mode === "timeout" ? 25 : 10_000
      });
      const port = await listen(runtime);
      const first = await openSocket(port);
      const second = await openSocket(port);
      try {
        for (const [index, socket] of [first, second].entries()) {
          const ready = waitForMessage(socket, (message) => message.type === "session.ready");
          socket.send(JSON.stringify(hello(`${mode}-tool-token-${index}`, `${mode}-tool-user-${index}`)));
          await ready;
        }
        const timedOut = mode === "timeout"
          ? waitForMessage(first, (message) => message.run_id === "timeout-tool-first"
            && (message.error as { code?: string } | undefined)?.code === "run_failed")
          : undefined;
        first.send(JSON.stringify(clientMessage(`${mode}-tool-first`, `${mode}-tool-conversation-first`)));
        await waitUntil(() => fetchCalls === 1);
        if (mode === "cancel") {
          const cancelled = waitForMessage(first, (message) => message.run_id === "cancel-tool-first"
            && (message.error as { code?: string } | undefined)?.code === "run_cancelled");
          first.send(JSON.stringify({ type: "turn.cancel", run_id: "cancel-tool-first" }));
          await cancelled;
        } else {
          await timedOut;
        }
        await firstSettled;
        await new Promise<void>((resolve) => setImmediate(resolve));

        second.send(JSON.stringify(clientMessage(`${mode}-tool-second`, `${mode}-tool-conversation-second`)));
        await waitUntil(() => fetchCalls === 2);
      } finally {
        first.close();
        second.close();
        await runtime.close();
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("HATCH_WEB_SEARCH_PROVIDER", originalProvider);
    restoreEnvironment("HATCH_WEB_SEARCH_URL", originalUrl);
    restoreEnvironment("HATCH_WEB_SEARCH_API_KEY", originalKey);
  }
});

test("ready connection caps release on close and distinguish per-user from global pressure", async () => {
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-connection-capacity-"))),
    maxEstablishedConnectionsGlobal: 2,
    maxEstablishedConnectionsPerUser: 1
  });
  const port = await listen(runtime);
  const sockets: WebSocket[] = [];
  try {
    const first = await openSocket(port);
    sockets.push(first);
    const firstReady = waitForMessage(first, (message) => message.type === "session.ready");
    first.send(JSON.stringify(hello("connection-token-one", "connection-user-one")));
    await firstReady;

    const sameUser = await openSocket(port);
    sockets.push(sameUser);
    const userRejected = waitForMessage(sameUser, (message) => (message.error as { code?: string } | undefined)?.code === "user_connection_capacity");
    sameUser.send(JSON.stringify(hello("connection-token-two", "connection-user-one")));
    assert.equal(((await userRejected).error as { code?: string }).code, "user_connection_capacity");

    const secondUser = await openSocket(port);
    sockets.push(secondUser);
    const secondReady = waitForMessage(secondUser, (message) => message.type === "session.ready");
    secondUser.send(JSON.stringify(hello("connection-token-three", "connection-user-two")));
    await secondReady;

    const globalOverflow = await openSocket(port);
    sockets.push(globalOverflow);
    const globalRejected = waitForMessage(globalOverflow, (message) => (message.error as { code?: string } | undefined)?.code === "connection_capacity");
    globalOverflow.send(JSON.stringify(hello("connection-token-four", "connection-user-three")));
    assert.equal(((await globalRejected).error as { code?: string }).code, "connection_capacity");

    const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()));
    first.close();
    await firstClosed;
    const admitted = await openSocket(port);
    sockets.push(admitted);
    const admittedReady = waitForMessage(admitted, (message) => message.type === "session.ready");
    admitted.send(JSON.stringify(hello("connection-token-five", "connection-user-one")));
    await admittedReady;
  } finally {
    for (const socket of sockets) socket.close();
    await runtime.close();
  }
});

test("ready connections receive heartbeats and are reaped after the idle deadline", async () => {
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-heartbeat-"))),
    connectionHeartbeatMs: 10,
    connectionIdleTimeoutMs: 45
  });
  const port = await listen(runtime);
  const socket = await openSocket(port);
  socket.on("error", () => undefined);
  let pingCount = 0;
  socket.on("ping", () => { pingCount += 1; });
  try {
    const ready = waitForMessage(socket, (message) => message.type === "session.ready");
    socket.send(JSON.stringify(hello("heartbeat-token", "heartbeat-user")));
    await ready;
    const closeCode = await new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    assert.equal(closeCode, 1006);
    assert.ok(pingCount >= 1);
  } finally {
    socket.close();
    await runtime.close();
  }
});

test("turn.cancel tombstones pending authorization and an abort-ignoring resolver cannot start the model", async () => {
  const entitlement = fixtureEntitlement();
  const tokenCalls = new Map<string, number>();
  let markPendingStarted!: () => void;
  const pendingStarted = new Promise<void>((resolve) => { markPendingStarted = resolve; });
  let releaseIgnoredAuthorization!: (identity: { sub: string; role: "user" }) => void;
  const ignoredAuthorization = new Promise<{ sub: string; role: "user" }>((resolve) => {
    releaseIgnoredAuthorization = resolve;
  });
  const identityResolver: AuthIdentityResolver = {
    resolveIdentity: async (token) => {
      const calls = (tokenCalls.get(token ?? "") ?? 0) + 1;
      tokenCalls.set(token ?? "", calls);
      if (token === "session-one" && calls === 2) {
        markPendingStarted();
        // Deliberately ignore AbortSignal to prove the Runtime tombstone is
        // authoritative even with a buggy or stale resolver implementation.
        return ignoredAuthorization;
      }
      return { sub: entitlement.user_id, role: "user" };
    }
  };
  let runCalls = 0;
  const runtime = createRuntimeServer({
    createRuntime: () => completingRuntime(() => { runCalls += 1; }),
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-pending-cancel-"))),
    authIdentityResolver: identityResolver,
    entitlementResolver: fixtureEntitlementResolver(entitlement),
    agentCorpusResolver: fixtureCorpusResolver(entitlement)
  });
  const port = await listen(runtime);
  let first: WebSocket | undefined;
  let second: WebSocket | undefined;
  try {
    first = await connectEntitledSocket(port, entitlement, "session-one", "install-one");
    const firstMessages: Array<Record<string, unknown>> = [];
    first.on("message", (data) => firstMessages.push(JSON.parse(String(data)) as Record<string, unknown>));
    first.send(JSON.stringify(clientMessage("run-pending-cancel", "shared-conversation")));
    await pendingStarted;

    const cancelled = waitForMessage(first, (message) => message.run_id === "run-pending-cancel"
      && (message.error as { code?: string } | undefined)?.code === "run_cancelled");
    first.send(JSON.stringify({ type: "turn.cancel", run_id: "run-pending-cancel", reason: "buyer stopped" }));
    assert.equal(((await cancelled).error as { code?: string }).code, "run_cancelled");

    const duplicate = waitForMessage(first, (message) => message.run_id === "run-pending-cancel"
      && (message.error as { code?: string } | undefined)?.code === "duplicate_run_id");
    first.send(JSON.stringify(clientMessage("run-pending-cancel", "different-conversation")));
    assert.equal(((await duplicate).error as { code?: string }).code, "duplicate_run_id");

    const connectionBusy = waitForMessage(first, (message) => message.run_id === "run-cancel-spam"
      && (message.error as { code?: string } | undefined)?.code === "connection_busy");
    first.send(JSON.stringify(clientMessage("run-cancel-spam", "different-conversation")));
    assert.equal(((await connectionBusy).error as { code?: string }).code, "connection_busy");
    assert.equal(tokenCalls.get("session-one"), 2);

    // The conversation reservation is released immediately, even though the
    // first connection keeps its authorization slot until the old resolver settles.
    second = await connectEntitledSocket(port, entitlement, "session-two", "install-two");
    const secondCompleted = waitForMessage(second, (message) => message.type === "turn.completed" && message.run_id === "run-second-connection");
    second.send(JSON.stringify(clientMessage("run-second-connection", "shared-conversation")));
    await secondCompleted;
    assert.equal(runCalls, 1);

    releaseIgnoredAuthorization({ sub: entitlement.user_id, role: "user" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runCalls, 1);
    assert.equal(firstMessages.filter((message) => message.run_id === "run-pending-cancel"
      && (message.error as { code?: string } | undefined)?.code === "run_cancelled").length, 1);

    const afterLateReturn = waitForMessage(first, (message) => message.type === "turn.completed" && message.run_id === "run-after-late-auth");
    first.send(JSON.stringify(clientMessage("run-after-late-auth", "after-late-conversation")));
    await afterLateReturn;
    assert.equal(runCalls, 2);
  } finally {
    releaseIgnoredAuthorization({ sub: entitlement.user_id, role: "user" });
    first?.close();
    second?.close();
    await runtime.close();
  }
});

test("one connection rejects an active run_id reused for a different conversation", async () => {
  let markRunStarted!: () => void;
  const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
  let releaseRun!: () => void;
  const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  let runCalls = 0;
  const agentRuntime: AgentRuntime = {
    async *run(input) {
      runCalls += 1;
      markRunStarted();
      await runGate;
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  };
  const runtime = createRuntimeServer({
    createRuntime: () => agentRuntime,
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-run-id-")))
  });
  const port = await listen(runtime);
  const socket = await openSocket(port);
  try {
    const ready = waitForMessage(socket, (message) => message.type === "session.ready");
    socket.send(JSON.stringify(hello("fixture-token", "duplicate-run-install")));
    await ready;
    socket.send(JSON.stringify(clientMessage("same-run-id", "conversation-one")));
    await runStarted;

    const duplicate = waitForMessage(socket, (message) => message.run_id === "same-run-id"
      && (message.error as { code?: string } | undefined)?.code === "duplicate_run_id");
    socket.send(JSON.stringify(clientMessage("same-run-id", "conversation-two")));
    assert.equal(((await duplicate).error as { code?: string }).code, "duplicate_run_id");
    assert.equal(runCalls, 1);
  } finally {
    releaseRun();
    socket.close();
    await runtime.close();
  }
});

test("Runtime closes oversized WebSocket frames safely and remains healthy", async () => {
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-max-payload-")))
  });
  const port = await listen(runtime);
  const socket = await openSocket(port);
  try {
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    socket.on("error", () => undefined);
    socket.send(Buffer.alloc(MAX_RUNTIME_WEBSOCKET_PAYLOAD_BYTES + 1, 0x20));
    assert.equal(await closed, 1009);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    socket.close();
    await runtime.close();
  }
});

test("outbound WebSocket byte pressure terminates the consumer and releases the run lease", async () => {
  let runCalls = 0;
  let markSlowRunStarted!: () => void;
  const slowRunStarted = new Promise<void>((resolve) => { markSlowRunStarted = resolve; });
  let releaseSlowOutput!: () => void;
  const slowOutputGate = new Promise<void>((resolve) => { releaseSlowOutput = resolve; });
  const agentRuntime: AgentRuntime = {
    async *run(input) {
      runCalls += 1;
      if (input.run_id === "slow-consumer-run") {
        markSlowRunStarted();
        await slowOutputGate;
        yield {
          type: "assistant.delta",
          run_id: input.run_id,
          delta: { kind: "text", content: "bounded output" }
        };
        yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
        return;
      }
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  };
  const runtime = createRuntimeServer({
    createRuntime: () => agentRuntime,
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-outbound-pressure-"))),
    maxActiveRunsGlobal: 1,
    maxSocketBufferedBytes: MAX_RUNTIME_WEBSOCKET_PAYLOAD_BYTES
  });
  let acceptedSocket: WebSocket | undefined;
  runtime.wss.once("connection", (socket) => { acceptedSocket = socket; });
  const port = await listen(runtime);
  const first = await openSocket(port);
  first.on("error", () => undefined);
  let second: WebSocket | undefined;
  try {
    const ready = waitForMessage(first, (message) => message.type === "session.ready");
    first.send(JSON.stringify(hello("outbound-pressure-one", "outbound-pressure-user-one")));
    await ready;
    const closed = new Promise<void>((resolve) => first.once("close", () => resolve()));
    first.send(JSON.stringify(clientMessage("slow-consumer-run", "outbound-pressure-conversation")));
    await slowRunStarted;
    assert.ok(acceptedSocket);
    Object.defineProperty(acceptedSocket, "bufferedAmount", {
      configurable: true,
      get: () => MAX_RUNTIME_WEBSOCKET_PAYLOAD_BYTES
    });
    releaseSlowOutput();
    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));

    second = await openSocket(port);
    const secondReady = waitForMessage(second, (message) => message.type === "session.ready");
    second.send(JSON.stringify(hello("outbound-pressure-two", "outbound-pressure-user-two")));
    await secondReady;
    const completed = waitForMessage(second, (message) => message.type === "turn.completed" && message.run_id === "after-pressure-run");
    second.send(JSON.stringify(clientMessage("after-pressure-run", "outbound-pressure-conversation")));
    await completed;
    assert.equal(runCalls, 2);
  } finally {
    first.close();
    second?.close();
    await runtime.close();
  }
});

test("oversized protocol fields fail as controlled messages without consuming hello", async () => {
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-field-bounds-")))
  });
  const port = await listen(runtime);
  const socket = await openSocket(port);
  try {
    const rejected = waitForMessage(socket, (message) => (message.error as { code?: string } | undefined)?.code === "protocol_error");
    socket.send(JSON.stringify(hello("fixture-token", "x".repeat(257))));
    assert.equal(((await rejected).error as { code?: string }).code, "protocol_error");

    const ready = waitForMessage(socket, (message) => message.type === "session.ready");
    socket.send(JSON.stringify(hello("fixture-token", "bounded-installation")));
    assert.equal((await ready).type, "session.ready");
  } finally {
    socket.close();
    await runtime.close();
  }
});

test("HTTP malformed paths and async store failures are controlled without unhandled rejection", async () => {
  const store = {
    append: async () => undefined,
    readVisibleConversation: async () => { throw new Error("simulated store outage"); },
    close: async () => undefined
  } as unknown as RuntimeStore;
  const runtime = createRuntimeServer({ conversationStore: store });
  const port = await listen(runtime);
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const malformed = await fetch(`http://127.0.0.1:${port}/conversations/%E0%A4%A/messages`);
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { error: { code: string } }).error.code, "invalid_request_path");

    const history = new URL(`http://127.0.0.1:${port}/conversations/conversation/messages`);
    history.searchParams.set("creator_id", "creator");
    history.searchParams.set("user_id", "user");
    history.searchParams.set("agent_id", "agent");
    history.searchParams.set("product_id", "product");
    history.searchParams.set("corpus_digest", `sha256:${"0".repeat(64)}`);
    const failed = await fetch(history);
    assert.equal(failed.status, 500);
    assert.equal(((await failed.json()) as { error: { code: string } }).error.code, "internal_error");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await runtime.close();
  }
});

test("HTTP history responses are rejected before writing beyond the configured byte cap", async () => {
  const store = {
    readVisibleConversation: async () => [{
      run_id: "large-history-run",
      role: "assistant",
      content: "x".repeat(2_000),
      timestamp: new Date().toISOString()
    }],
    close: async () => undefined
  } as unknown as RuntimeStore;
  const runtime = createRuntimeServer({
    conversationStore: store,
    maxHttpResponseBytes: 1_024
  });
  const port = await listen(runtime);
  try {
    const history = new URL(`http://127.0.0.1:${port}/conversations/large/messages`);
    history.searchParams.set("creator_id", "creator");
    history.searchParams.set("user_id", "user");
    history.searchParams.set("agent_id", "agent");
    history.searchParams.set("product_id", "product");
    history.searchParams.set("corpus_digest", `sha256:${"0".repeat(64)}`);
    const response = await fetch(history);
    assert.equal(response.status, 413);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "response_too_large");
  } finally {
    await runtime.close();
  }
});

test("HTTP Registry authorization failures return controlled 503 responses", async () => {
  const entitlement = fixtureEntitlement();
  const identityResolver: AuthIdentityResolver = {
    resolveIdentity: async () => ({ sub: entitlement.user_id, role: "user" })
  };
  const unavailableEntitlements: EntitlementResolver = {
    list: async () => { throw new EntitlementError("entitlement_registry_unavailable", "upstream detail"); },
    resolve: async () => { throw new EntitlementError("entitlement_registry_unavailable", "upstream detail"); }
  };
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-http-auth-"))),
    authIdentityResolver: identityResolver,
    entitlementResolver: unavailableEntitlements,
    agentCorpusResolver: fixtureCorpusResolver(entitlement)
  });
  const port = await listen(runtime);
  try {
    const library = await fetch(`http://127.0.0.1:${port}/v1/me/creator-agents`, {
      headers: { authorization: "Bearer opaque-session" }
    });
    assert.equal(library.status, 503);
    assert.deepEqual(await library.json(), {
      error: {
        code: "authorization_unavailable",
        message: "Hatch could not verify access right now. Try again shortly."
      }
    });

    const history = new URL(`http://127.0.0.1:${port}/conversations/conversation/messages`);
    history.searchParams.set("entitlement_id", entitlement.entitlement_id);
    history.searchParams.set("creator_id", entitlement.creator_id);
    history.searchParams.set("agent_id", entitlement.agent_id);
    const response = await fetch(history, { headers: { authorization: "Bearer opaque-session" } });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "authorization_unavailable");
  } finally {
    await runtime.close();
  }
});

test("HTTP per-source gate keeps a disconnected resolver lease until the work settles", async () => {
  const signals: AbortSignal[] = [];
  const releases: Array<(identity: { sub: string; role: "user" } | undefined) => void> = [];
  const identityResolver: AuthIdentityResolver = {
    resolveIdentity: async (_token, options) => {
      if (options?.signal) signals.push(options.signal);
      return new Promise((resolve) => releases.push(resolve));
    }
  };
  const entitlements: EntitlementResolver = {
    list: async () => [],
    resolve: async () => fixtureEntitlement()
  };
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-http-source-gate-"))),
    authIdentityResolver: identityResolver,
    entitlementResolver: entitlements,
    agentCorpusResolver: fixtureCorpusResolver(fixtureEntitlement()),
    maxHttpRequestsGlobal: 4,
    maxHttpRequestsPerSource: 1,
    httpRequestTimeoutMs: 1_000
  });
  const port = await listen(runtime);
  const clientAbort = new AbortController();
  try {
    const disconnected = fetch(`http://127.0.0.1:${port}/v1/me/creator-agents`, {
      headers: { authorization: "Bearer disconnected-session" },
      signal: clientAbort.signal
    });
    await waitUntil(() => releases.length === 1);
    clientAbort.abort();
    await assert.rejects(disconnected, /abort/i);
    await waitUntil(() => signals[0]?.aborted === true);

    const blocked = await fetch(`http://127.0.0.1:${port}/v1/me/creator-agents`, {
      headers: { authorization: "Bearer source-overflow" }
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, "source_busy");
    assert.equal(releases.length, 1);

    releases[0]?.(undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const admitted = fetch(`http://127.0.0.1:${port}/v1/me/creator-agents`, {
      headers: { authorization: "Bearer source-admitted" }
    });
    await waitUntil(() => releases.length === 2);
    releases[1]?.({ sub: "http-user", role: "user" });
    assert.equal((await admitted).status, 200);
  } finally {
    for (const release of releases) release(undefined);
    await runtime.close();
  }
});

test("HTTP global gate and request deadline bound abort-ignoring authorization work", async () => {
  const signals: AbortSignal[] = [];
  const releases: Array<(identity: undefined) => void> = [];
  const identityResolver: AuthIdentityResolver = {
    resolveIdentity: async (_token, options) => {
      if (options?.signal) signals.push(options.signal);
      return new Promise<undefined>((resolve) => releases.push(resolve));
    }
  };
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-http-global-gate-"))),
    authIdentityResolver: identityResolver,
    entitlementResolver: {
      list: async () => [],
      resolve: async () => fixtureEntitlement()
    },
    agentCorpusResolver: fixtureCorpusResolver(fixtureEntitlement()),
    maxHttpRequestsGlobal: 2,
    maxHttpRequestsPerSource: 3,
    httpRequestTimeoutMs: 35
  });
  const port = await listen(runtime);
  try {
    const first = fetch(`http://127.0.0.1:${port}/v1/me/creator-agents`, {
      headers: { authorization: "Bearer global-one" }
    });
    const second = fetch(`http://127.0.0.1:${port}/v1/me/creator-agents`, {
      headers: { authorization: "Bearer global-two" }
    });
    await waitUntil(() => releases.length === 2);
    assert.equal((await first).status, 504);
    assert.equal((await second).status, 504);
    assert.ok(signals.every((signal) => signal.aborted));

    const blocked = await fetch(`http://127.0.0.1:${port}/v1/me/creator-agents`, {
      headers: { authorization: "Bearer global-overflow" }
    });
    assert.equal(blocked.status, 503);
    assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, "http_busy");
    assert.equal(releases.length, 2);
  } finally {
    for (const release of releases) release(undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await runtime.close();
  }
});

test("disconnect cleanup finishes when cancellation persistence fails", async () => {
  let storeClosed = false;
  const store = {
    append: async (event: { type: string; status?: string; to?: string }) => {
      if ((event.type === "tool.call" && event.status === "cancelled")
        || (event.type === "turn.state" && event.to === "cancelled")) {
        throw new Error("cancellation persistence unavailable");
      }
    },
    readConversation: async () => [],
    close: async () => { storeClosed = true; }
  } as unknown as RuntimeStore;
  const agentRuntime: AgentRuntime = {
    async *run(input, context) {
      await context.clientBroker.execute(
        input.run_id,
        "file_read",
        { path: "pending.txt" },
        context.state,
        "disconnect-tool"
      );
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  };
  const runtime = createRuntimeServer({ createRuntime: () => agentRuntime, conversationStore: store });
  const port = await listen(runtime);
  const socket = await openSocket(port);
  let closed = false;
  try {
    const ready = waitForMessage(socket, (message) => message.type === "session.ready");
    socket.send(JSON.stringify({ ...hello("fixture-token", "disconnect-install"), local_tools: ["file_read"] }));
    await ready;
    const requested = waitForMessage(socket, (message) => message.type === "tool_call.request");
    socket.send(JSON.stringify(clientMessage("disconnect-run", "disconnect-conversation")));
    await requested;
    socket.close();

    assert.equal(await Promise.race([
      runtime.close().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))
    ]), true);
    closed = true;
    assert.equal(storeClosed, true);
  } finally {
    socket.close();
    if (!closed) await runtime.close();
  }
});

test("entitlement-backed turns reject a creator identity even with a permissive resolver", async () => {
  const entitlement = fixtureEntitlement();
  let role: "user" | "creator" = "user";
  let runCalls = 0;
  const identityResolver: AuthIdentityResolver = {
    resolveIdentity: async () => ({ sub: entitlement.user_id, role })
  };
  const runtime = createRuntimeServer({
    createRuntime: () => completingRuntime(() => { runCalls += 1; }),
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-creator-entitlement-"))),
    authIdentityResolver: identityResolver,
    entitlementResolver: fixtureEntitlementResolver(entitlement),
    agentCorpusResolver: fixtureCorpusResolver(entitlement)
  });
  const port = await listen(runtime);
  const socket = await connectEntitledSocket(port, entitlement, "role-changing-session", "role-changing-install");
  try {
    role = "creator";
    const rejected = waitForMessage(socket, (message) => message.run_id === "run-role-changed"
      && (message.error as { code?: string } | undefined)?.code === "entitlement_required");
    socket.send(JSON.stringify(clientMessage("run-role-changed", "role-change-conversation")));
    assert.equal(((await rejected).error as { code?: string }).code, "entitlement_required");
    assert.equal(runCalls, 0);

    const history = new URL(`http://127.0.0.1:${port}/conversations/role-change-conversation/messages`);
    history.searchParams.set("entitlement_id", entitlement.entitlement_id);
    history.searchParams.set("creator_id", entitlement.creator_id);
    history.searchParams.set("agent_id", entitlement.agent_id);
    const response = await fetch(history, { headers: { authorization: "Bearer role-changing-session" } });
    assert.equal(response.status, 403);
  } finally {
    socket.close();
    await runtime.close();
  }
});

test("a republished Agent Corpus fails the next turn with agent_updated before model work", async () => {
  const entitlement = fixtureEntitlement();
  const initial = await fixtureCorpusResolver(entitlement).resolve(entitlement.creator_id, entitlement.agent_id);
  let currentDigest = initial.digest;
  const corpusResolver = {
    resolve: async () => ({ ...initial, digest: currentDigest })
  } as unknown as AgentCorpusResolver;
  const identityResolver: AuthIdentityResolver = {
    resolveIdentity: async () => ({ sub: entitlement.user_id, role: "user" })
  };
  let runCalls = 0;
  const runtime = createRuntimeServer({
    createRuntime: () => completingRuntime(() => { runCalls += 1; }),
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-agent-updated-"))),
    authIdentityResolver: identityResolver,
    entitlementResolver: fixtureEntitlementResolver(entitlement),
    agentCorpusResolver: corpusResolver
  });
  const port = await listen(runtime);
  const socket = await connectEntitledSocket(port, entitlement, "agent-updated-session", "agent-updated-install");
  try {
    currentDigest = `sha256:${"f".repeat(64)}`;
    const rejected = waitForMessage(socket, (message) => message.run_id === "agent-updated-run"
      && (message.error as { code?: string } | undefined)?.code === "agent_updated");
    socket.send(JSON.stringify(clientMessage("agent-updated-run", "agent-updated-conversation")));
    assert.equal(((await rejected).error as { code?: string }).code, "agent_updated");
    assert.equal(runCalls, 0);
  } finally {
    socket.close();
    await runtime.close();
  }
});

function signLegacyToken(secret: string, subject: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: subject,
    role: "user",
    exp: Math.floor(Date.now() / 1000) + 3600
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function hello(token: string, installationId: string): Record<string, unknown> {
  return {
    type: "client.hello",
    protocol_version: "0.7",
    installation_id: installationId,
    auth_token: token,
    local_tools: []
  };
}

function clientMessage(runId: string, conversationId: string): Record<string, unknown> {
  return {
    type: "client.message",
    run_id: runId,
    conversation_id: conversationId,
    message: { role: "user", content: "Run the authorized task." }
  };
}

function fixtureEntitlement(): EntitlementBinding {
  return {
    entitlement_id: "ent-boundary",
    order_id: "order-boundary",
    user_id: "user-boundary",
    creator_id: "creator-boundary",
    agent_id: "agent-boundary",
    product_id: "product-boundary",
    status: "active"
  };
}

function fixtureEntitlementResolver(entitlement: EntitlementBinding): EntitlementResolver {
  return {
    list: async () => [entitlement],
    resolve: async () => entitlement
  };
}

function fixtureCorpusResolver(entitlement: EntitlementBinding): AgentCorpusResolver {
  const corpus = {
    agent_id: entitlement.agent_id,
    creator: { id: entitlement.creator_id, name: "Boundary Creator" },
    product: {
      id: entitlement.product_id,
      name: "Boundary Product",
      boundaries: [],
      presentation: {}
    },
    knowledge: { documents: [] },
    tools: []
  } as unknown as AgentCorpus;
  return {
    resolve: async () => ({ root: "", corpus, digest: `sha256:${"1".repeat(64)}` })
  } as unknown as AgentCorpusResolver;
}

function fixtureCreatorToolCorpus(entitlement: EntitlementBinding): AgentCorpus {
  return {
    agent_id: entitlement.agent_id,
    creator: { id: entitlement.creator_id, name: "Boundary Creator" },
    product: {
      id: entitlement.product_id,
      name: "Boundary Product",
      boundaries: [],
      presentation: {}
    },
    knowledge: { documents: [] },
    tools: [{
      id: "creator.boundary.lookup",
      kind: "http_function",
      connection_ref: "boundary-api",
      operation: "lookup",
      description: "Lookup a boundary fixture.",
      input_schema: { type: "object", properties: {}, additionalProperties: false }
    }]
  } as unknown as AgentCorpus;
}

async function writeCreatorCorpusFixture(entitlement: EntitlementBinding): Promise<{ baseRoot: string }> {
  const baseRoot = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-creator-rotation-corpus-"));
  const corpusRoot = path.join(baseRoot, entitlement.creator_id, entitlement.agent_id);
  await mkdir(path.join(corpusRoot, "instructions"), { recursive: true });
  await mkdir(path.join(corpusRoot, "evals"), { recursive: true });
  const system = "Use the current Creator tool binding.";
  const evaluations = "[]";
  await writeFile(path.join(corpusRoot, "instructions/system.md"), system, "utf8");
  await writeFile(path.join(corpusRoot, "evals/evals.json"), evaluations, "utf8");
  await writeFile(path.join(corpusRoot, "agent.json"), JSON.stringify({
    contract_version: "1",
    agent_id: entitlement.agent_id,
    creator: { id: entitlement.creator_id, name: "Boundary Creator" },
    product: { id: entitlement.product_id, name: "Boundary Product" },
    instructions: { system: corpusAsset("system", "instructions/system.md", system) },
    skills: [],
    knowledge: { documents: [] },
    tools: [
      { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
      {
        id: "creator.boundary.lookup",
        kind: "http_function",
        connection_ref: "boundary-api",
        operation: "lookup",
        description: "Lookup a boundary fixture.",
        input_schema: { type: "object", properties: {}, additionalProperties: false }
      }
    ],
    evaluations: {
      synthetic_qa: [corpusAsset("synthetic", "evals/evals.json", evaluations)],
      held_out: [corpusAsset("held-out", "evals/evals.json", evaluations)]
    }
  }), "utf8");
  return { baseRoot };
}

function corpusAsset(id: string, assetPath: string, content: string): { id: string; path: string; sha256: string } {
  return {
    id,
    path: assetPath,
    sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`
  };
}

function completingRuntime(onRun: () => void): AgentRuntime {
  return {
    async *run(input) {
      onRun();
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  };
}

async function connectEntitledSocket(
  port: number,
  entitlement: EntitlementBinding,
  token: string,
  installationId: string
): Promise<WebSocket> {
  const socket = await openSocket(port);
  const ready = waitForMessage(socket, (message) => message.type === "session.ready");
  socket.send(JSON.stringify({
    ...hello(token, installationId),
    entitlement_id: entitlement.entitlement_id,
    creator_id: entitlement.creator_id,
    agent_id: entitlement.agent_id
  }));
  assert.equal((await ready).type, "session.ready");
  return socket;
}

async function listen(runtime: RuntimeServer): Promise<number> {
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function openSocket(port: number, headers?: Record<string, string>): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/runtime`, headers ? { headers } : undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function waitForMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Runtime WebSocket message"));
    }, 2_000);
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
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Runtime condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
