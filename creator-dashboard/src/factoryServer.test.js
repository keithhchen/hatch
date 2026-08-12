import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";

test("Dashboard BFF authenticates and forwards Creator Factory requests without adding creator_id", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-factory-"));
  const forwarded = [];
  const registry = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://registry.test");
    let content = "";
    for await (const chunk of request) content += chunk;
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/auth/signin") {
      response.end(JSON.stringify({
        token: "signed-creator-token",
        account: { id: "creator-factory", role: "creator", email: "creator@example.test", display_name: "Factory Creator" }
      }));
      return;
    }
    if (url.pathname === "/v1/auth/me") {
      response.end(JSON.stringify({ id: "creator-factory", role: "creator", email: "creator@example.test", display_name: "Factory Creator" }));
      return;
    }
    if (url.pathname === "/v1/creator/factory-runs") {
      forwarded.push({ method: request.method, headers: request.headers, body: content ? JSON.parse(content) : undefined });
      response.statusCode = request.method === "POST" ? 202 : 200;
      response.end(JSON.stringify(request.method === "POST"
        ? { id: "factory_1", task_name: "Offer critique", status: "queued", version: 1, pending_questions: [] }
        : { runs: [] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ detail: "not found" }));
  });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry),
    factoryRequestMaxBytes: 512,
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const token = await login(api);
  const payload = {
    task_name: "Offer critique",
    task_brief: "Return final copy.",
    sources: [{ id: "S1", authority: "creator_current", title: "Correction", content: "Choose one." }]
  };
  const createDraft = () => fetch(`${serverUrl(api)}/v1/creator/factory-drafts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "factory-draft-create-1"
    },
    body: JSON.stringify({ ...payload, expected_version: 0 })
  });
  const createdDraftResponse = await createDraft();
  const createdDraft = (await createdDraftResponse.json()).draft;
  assert.equal(createdDraftResponse.status, 201);
  assert.match(createdDraft.draft_id, /^draft_[a-f0-9]{24}$/);
  assert.equal(createdDraft.version, 1);
  const createdDraftReplay = await createDraft();
  assert.equal(createdDraftReplay.status, 201);
  assert.equal((await createdDraftReplay.json()).draft.version, 1);

  const saveDraft = () => fetch(`${serverUrl(api)}/v1/creator/factory-drafts/default`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "factory-draft-save-1"
    },
    body: JSON.stringify({ ...payload, expected_version: 0 })
  });
  const savedResponse = await saveDraft();
  const saved = (await savedResponse.json()).draft;
  assert.equal(savedResponse.status, 200);
  assert.equal(saved.version, 1);
  const saveReplay = await saveDraft();
  assert.equal(saveReplay.status, 200);
  assert.equal((await saveReplay.json()).draft.version, 1);
  const changedReplay = await fetch(`${serverUrl(api)}/v1/creator/factory-drafts/default`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "factory-draft-save-1"
    },
    body: JSON.stringify({ ...payload, task_brief: "Changed", expected_version: 0 })
  });
  assert.equal(changedReplay.status, 409);
  assert.equal((await changedReplay.json()).error.code, "idempotency_conflict");

  const startDraft = (expectedVersion = 1) => fetch(`${serverUrl(api)}/v1/creator/factory-drafts/default/start`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "factory-draft-start-1"
      },
      body: JSON.stringify({ expected_version: expectedVersion })
    });
  const startedResponse = await startDraft();
  const started = await startedResponse.json();
  assert.equal(startedResponse.status, 202);
  assert.equal(started.run.id, "factory_1");
  assert.deepEqual(forwarded[0].body, payload);
  const startReplay = await startDraft();
  assert.equal(startReplay.status, 202);
  assert.equal((await startReplay.json()).run.id, "factory_1");
  assert.equal(forwarded.length, 1);
  const changedStartReplay = await startDraft(2);
  assert.equal(changedStartReplay.status, 409);
  assert.equal((await changedStartReplay.json()).error.code, "idempotency_conflict");

  const response = await fetch(`${serverUrl(api)}/v1/creator/factory-runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "factory-request-1"
    },
    body: JSON.stringify(payload)
  });

  assert.equal(response.status, 202);
  assert.equal((await response.json()).id, "factory_1");
  assert.equal(forwarded.length, 2);
  assert.equal(forwarded[1].headers.authorization, "Bearer signed-creator-token");
  assert.equal(forwarded[1].headers["idempotency-key"], "factory-request-1");
  assert.deepEqual(forwarded[1].body, payload);
  assert.equal("creator_id" in forwarded[1].body, false);

  const oversized = await fetch(`${serverUrl(api)}/v1/creator/factory-runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "factory-request-too-large"
    },
    body: JSON.stringify({ ...payload, task_brief: "x".repeat(600) })
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, "request_body_too_large");
  assert.equal(forwarded.length, 2);
});

async function login(server) {
  const response = await fetch(`${serverUrl(server)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "creator@example.test", password: "test-only" })
  });
  return (await response.json()).token;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}
