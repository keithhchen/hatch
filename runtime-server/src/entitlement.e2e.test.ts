import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { WebSocket } from "ws";
import { DeterministicAgentRuntime, type AgentRuntime, type RunContext } from "./agentRuntime.js";
import type { EntitlementBinding, EntitlementLookup, EntitlementResolver } from "./entitlements.js";
import { createRuntimeServer, type RuntimeServer } from "./index.js";
import { runLocalHarness } from "./localHarness.js";
import { CreatorReleaseResolver, computeCreatorReleaseDigest, type CreatorReleasePrivate, type CreatorReleasePublic } from "./release.js";
import type { OutboundMessage, RunStart } from "./protocol.js";

const temporaryDirectories: string[] = [];
const servers: RuntimeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  delete process.env.HATCH_RUNTIME_DATA_DIR;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.HATCH_CREATOR_MODEL;
  delete process.env.HATCH_REVIEWER_API_KEY;
  delete process.env.HATCH_REVIEWER_BASE_URL;
  delete process.env.HATCH_REVIEWER_MODEL;
  delete process.env.HATCH_RUNTIME_DELIVERY_AUDIT;
});

test("Release delivery workflow hides unsafe drafts and proposed writes until an audited revision passes", async () => {
  const releaseFixture = await createReleaseFixture(true);
  const workspace = await tempDirectory("hatch-audited-workspace-");
  process.env.HATCH_RUNTIME_DATA_DIR = await tempDirectory("hatch-audited-runtime-");
  const mock = await createDeliveryAuditMock("revise");
  configureMockModels(mock.baseUrl);
  try {
    const entitlement = entitlementFor(releaseFixture.releaseId, releaseFixture.digest);
    const runtime = createRuntimeServer({
      releaseResolver: new CreatorReleaseResolver(releaseFixture.root),
      entitlementResolver: new MemoryEntitlementResolver("license_fixture", entitlement)
    });
    servers.push(runtime);
    const result = await runLocalHarness({
      serverUrl: await listen(runtime),
      workspace,
      prompt: "Write the evidence-grounded review to result.md.",
      licenseToken: "license_fixture",
      entitlementId: entitlement.entitlement_id
    });

    assert.equal(result.finalText, "SAFE FINAL");
    assert.equal(await readFile(path.join(workspace, "result.md"), "utf8"), "SAFE FILE");
    const visible = JSON.stringify(result.events);
    assert.doesNotMatch(visible, /UNSAFE FILE|UNSAFE FINAL/);
    const writes = result.events.filter((event) => event.type === "tool_call.request" && event.name === "fs.write");
    assert.equal(writes.length, 1);
    assert.match(JSON.stringify(writes[0]), /SAFE FILE/);
    assert.ok(mock.requests.some((request) => JSON.stringify(request).includes("FACTORY_AUDIT_INSTRUCTION")));
    assert.ok(mock.requests.some((request) => JSON.stringify(request).includes("FACTORY_REVISION_INSTRUCTION")));
    assert.ok(mock.requests.every((request) => request.model === "kimi-k2.6"));
    assert.ok(mock.requests.every((request) => request.temperature === 1));
    assert.ok(mock.requests.every((request) => request.thinking === undefined));
    assert.ok(mock.requests.every((request) => {
      const tools = (request.tools ?? []).map((tool: Record<string, any>) => tool.function?.name);
      return !tools.includes("web_search") && !tools.includes("api_request") && !tools.includes("mcp_call");
    }));
    const reviewerRequests = mock.requests.filter((request) => request.response_format?.type === "json_object");
    assert.ok(reviewerRequests.length > 0);
    assert.ok(reviewerRequests.every((request) => request.model === "kimi-k2.6"));
    assert.ok(reviewerRequests.every((request) => request.temperature === 1));
    assert.ok(reviewerRequests.every((request) => request.thinking === undefined));
    assert.ok(reviewerRequests.every((request) => request.reasoning_format === undefined));
    for (const request of reviewerRequests) {
      assert.match(String(request.messages?.[0]?.content ?? ""), /^FACTORY_AUDIT_INSTRUCTION/);
      assert.match(String(request.messages?.[0]?.content ?? ""), /Runtime batching rule/);
      const payload = JSON.parse(String(request.messages?.[1]?.content ?? "{}"));
      assert.deepEqual(payload.evidence_authority, {
        user_fact_sources: ["user_input", "approved_tool_evidence"],
        creator_method_sources: ["protected_knowledge"],
        protected_knowledge_cannot_support_user_specific_claims: true
      });
      assert.ok(Array.isArray(payload.user_input));
      assert.ok(Array.isArray(payload.approved_tool_evidence));
      assert.doesNotMatch(payload.protected_knowledge, /RAG-CAMPAIGN-EVIDENCE/);
      assert.match(payload.protected_knowledge, /FEW-SHOT-ANSWER/);
      assert.doesNotMatch(payload.protected_knowledge, /Apply the protected standards/);
      assert.doesNotMatch(payload.protected_knowledge, /PROTECTED-SKILL-INSTRUCTION/);
      assert.equal("conversation_and_tool_evidence" in payload, false);
      assert.equal("original_user_input" in payload, false);
    }
  } finally {
    await mock.close();
  }
});

test("unresolved audited delivery returns only a boundary-safe partial", async () => {
  const releaseFixture = await createReleaseFixture(true);
  const workspace = await tempDirectory("hatch-partial-workspace-");
  process.env.HATCH_RUNTIME_DATA_DIR = await tempDirectory("hatch-partial-runtime-");
  const mock = await createDeliveryAuditMock("safe_partial");
  configureMockModels(mock.baseUrl);
  try {
    const entitlement = entitlementFor(releaseFixture.releaseId, releaseFixture.digest);
    const runtime = createRuntimeServer({
      releaseResolver: new CreatorReleaseResolver(releaseFixture.root),
      entitlementResolver: new MemoryEntitlementResolver("license_fixture", entitlement)
    });
    servers.push(runtime);
    const result = await runLocalHarness({
      serverUrl: await listen(runtime),
      workspace,
      prompt: "Give me the final review.",
      licenseToken: "license_fixture",
      entitlementId: entitlement.entitlement_id
    });
    assert.equal(result.finalText, "SAFE PARTIAL");
    assert.doesNotMatch(JSON.stringify(result.events), /UNSAFE FINAL|UNSAFE REVISION/);
  } finally {
    await mock.close();
  }
});

test("delivery audit treats an omitted claim unit as a failed review and revises before delivery", async () => {
  const releaseFixture = await createReleaseFixture(true);
  const workspace = await tempDirectory("hatch-coverage-workspace-");
  process.env.HATCH_RUNTIME_DATA_DIR = await tempDirectory("hatch-coverage-runtime-");
  const mock = await createDeliveryAuditMock("coverage_gap");
  configureMockModels(mock.baseUrl);
  try {
    const entitlement = entitlementFor(releaseFixture.releaseId, releaseFixture.digest);
    const runtime = createRuntimeServer({
      releaseResolver: new CreatorReleaseResolver(releaseFixture.root),
      entitlementResolver: new MemoryEntitlementResolver("license_fixture", entitlement)
    });
    servers.push(runtime);
    const result = await runLocalHarness({
      serverUrl: await listen(runtime),
      workspace,
      prompt: "Give me an evidence-grounded review.",
      licenseToken: "license_fixture",
      entitlementId: entitlement.entitlement_id
    });
    assert.equal(result.finalText, "SAFE COVERED");
    assert.doesNotMatch(JSON.stringify(result.events), /UNSUPPORTED SECOND/);
    const reviewerRequests = mock.requests.filter((request) => request.response_format?.type === "json_object");
    assert.ok(reviewerRequests.length >= 2);
    const firstPayload = JSON.parse(String(reviewerRequests[0]?.messages?.[1]?.content ?? "{}"));
    assert.equal(firstPayload.claim_inventory.length, 2);
  } finally {
    await mock.close();
  }
});

test("delivery audit covers a large response in bounded reviewer batches", async () => {
  const releaseFixture = await createReleaseFixture(true);
  const workspace = await tempDirectory("hatch-audit-batches-workspace-");
  process.env.HATCH_RUNTIME_DATA_DIR = await tempDirectory("hatch-audit-batches-runtime-");
  const mock = await createDeliveryAuditMock("coverage_batches");
  configureMockModels(mock.baseUrl);
  try {
    const entitlement = entitlementFor(releaseFixture.releaseId, releaseFixture.digest);
    const runtime = createRuntimeServer({
      releaseResolver: new CreatorReleaseResolver(releaseFixture.root),
      entitlementResolver: new MemoryEntitlementResolver("license_fixture", entitlement)
    });
    servers.push(runtime);
    const result = await runLocalHarness({
      serverUrl: await listen(runtime),
      workspace,
      prompt: "Give me the complete evidence-grounded review.",
      licenseToken: "license_fixture",
      entitlementId: entitlement.entitlement_id
    });
    assert.equal(result.finalText, coverageBatchDraft());
    const reviewerRequests = mock.requests.filter((request) => request.response_format?.type === "json_object");
    assert.equal(reviewerRequests.length, 2);
    const batchSizes = reviewerRequests.map((request) => JSON.parse(String(request.messages[1].content)).claim_inventory.length);
    assert.deepEqual(batchSizes, [20, 1]);
    assert.ok(reviewerRequests.every((request) => request.max_completion_tokens === 2_500));
    assert.ok(reviewerRequests.every((request) => request.temperature === 1));
    assert.ok(reviewerRequests.every((request) => request.thinking === undefined));
  } finally {
    await mock.close();
  }
});

test("delivery audit retries a malformed structured reviewer response without exposing the draft", async () => {
  const releaseFixture = await createReleaseFixture(true);
  const workspace = await tempDirectory("hatch-audit-retry-workspace-");
  process.env.HATCH_RUNTIME_DATA_DIR = await tempDirectory("hatch-audit-retry-runtime-");
  const mock = await createDeliveryAuditMock("malformed_then_valid");
  configureMockModels(mock.baseUrl);
  try {
    const entitlement = entitlementFor(releaseFixture.releaseId, releaseFixture.digest);
    const runtime = createRuntimeServer({
      releaseResolver: new CreatorReleaseResolver(releaseFixture.root),
      entitlementResolver: new MemoryEntitlementResolver("license_fixture", entitlement)
    });
    servers.push(runtime);
    const result = await runLocalHarness({
      serverUrl: await listen(runtime),
      workspace,
      prompt: "Give me the evidence-grounded review.",
      licenseToken: "license_fixture",
      entitlementId: entitlement.entitlement_id
    });
    assert.equal(result.finalText, "SAFE FINAL");
    const reviewerRequests = mock.requests.filter((request) => request.response_format?.type === "json_object");
    assert.equal(reviewerRequests.length, 2);
    assert.doesNotMatch(JSON.stringify(result.events), /json_validate_failed|malformed/i);
  } finally {
    await mock.close();
  }
});

test("delivery audit uses Kimi-compatible JSON object mode with local schema validation", async () => {
  const releaseFixture = await createReleaseFixture(true);
  const workspace = await tempDirectory("hatch-audit-format-fallback-workspace-");
  process.env.HATCH_RUNTIME_DATA_DIR = await tempDirectory("hatch-audit-format-fallback-runtime-");
  const mock = await createDeliveryAuditMock("schema_unsupported_then_json");
  configureMockModels(mock.baseUrl);
  try {
    const entitlement = entitlementFor(releaseFixture.releaseId, releaseFixture.digest);
    const runtime = createRuntimeServer({
      releaseResolver: new CreatorReleaseResolver(releaseFixture.root),
      entitlementResolver: new MemoryEntitlementResolver("license_fixture", entitlement)
    });
    servers.push(runtime);
    const result = await runLocalHarness({
      serverUrl: await listen(runtime),
      workspace,
      prompt: "Give me the evidence-grounded review.",
      licenseToken: "license_fixture",
      entitlementId: entitlement.entitlement_id
    });
    assert.equal(result.finalText, "SAFE FINAL");
    const reviewerRequests = mock.requests.filter((request) => request.response_format?.type === "json_object");
    assert.deepEqual(reviewerRequests.map((request) => request.response_format?.type), ["json_object"]);
    assert.ok(reviewerRequests.every((request) => request.model === "kimi-k2.6" && request.temperature === 1));
    assert.ok(reviewerRequests.every((request) => request.thinking === undefined));
  } finally {
    await mock.close();
  }
});

test("Creator Releases stream by default even when they carry an offline audit policy", async () => {
  const releaseFixture = await createReleaseFixture(true);
  const workspace = await tempDirectory("hatch-compatible-workspace-");
  process.env.HATCH_RUNTIME_DATA_DIR = await tempDirectory("hatch-compatible-runtime-");
  const mock = await createDeliveryAuditMock("compatibility");
  configureMockModels(mock.baseUrl);
  // This Release carries an offline audit policy, but ordinary deployments do
  // not enable the optional per-delivery audit. It must therefore preserve
  // the provider's real SSE delta stream.
  delete process.env.HATCH_RUNTIME_DELIVERY_AUDIT;
  try {
    const entitlement = entitlementFor(releaseFixture.releaseId, releaseFixture.digest);
    const runtime = createRuntimeServer({
      releaseResolver: new CreatorReleaseResolver(releaseFixture.root),
      entitlementResolver: new MemoryEntitlementResolver("license_fixture", entitlement)
    });
    servers.push(runtime);
    const result = await runLocalHarness({
      serverUrl: await listen(runtime),
      workspace,
      prompt: "Give me the normal response.",
      licenseToken: "license_fixture",
      entitlementId: entitlement.entitlement_id
    });
    assert.equal(result.finalText, "LEGACY STREAM");
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0]?.stream, true);
    const streamedText = result.events.reduce((text, event) => {
      if (event.type !== "assistant.delta" || event.delta.kind !== "text") return text;
      return text + event.delta.content;
    }, "");
    assert.equal(streamedText, "LEGACY STREAM");
  } finally {
    await mock.close();
  }
});

test("Creator Release buffers the model turn after local tool evidence", async () => {
  const releaseFixture = await createReleaseFixture();
  const workspace = await tempDirectory("hatch-tool-handoff-workspace-");
  process.env.HATCH_RUNTIME_DATA_DIR = await tempDirectory("hatch-tool-handoff-runtime-");
  await writeFile(path.join(workspace, "notes.txt"), "Hatch local evidence.\n", "utf8");
  const mock = await createPinnedToolHandoffMock();
  configureMockModels(mock.baseUrl);
  try {
    const entitlement = entitlementFor(releaseFixture.releaseId, releaseFixture.digest);
    const runtime = createRuntimeServer({
      releaseResolver: new CreatorReleaseResolver(releaseFixture.root),
      entitlementResolver: new MemoryEntitlementResolver("license_fixture", entitlement)
    });
    servers.push(runtime);
    const result = await runLocalHarness({
      serverUrl: await listen(runtime),
      workspace,
      prompt: "Find Hatch in local files.",
      licenseToken: "license_fixture",
      entitlementId: entitlement.entitlement_id
    });

    assert.equal(result.finalText, "LOCAL EVIDENCE FINAL");
    assert.deepEqual(result.events.filter((event) => event.type === "tool_call.request").map((event) => event.name), ["fs.search"]);
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[0]?.stream, true);
    assert.equal(mock.requests[1]?.stream, false);
    assert.ok(mock.requests[1]?.messages?.some((message: Record<string, unknown>) => (
      message.role === "user" && String(message.content ?? "").includes("approved_local_tool_evidence")
    )));
  } finally {
    await mock.close();
  }
});

test("Creator Release saves an explicit requested artifact after returning buffered final text", async () => {
  const releaseFixture = await createReleaseFixture();
  const workspace = await tempDirectory("hatch-tool-delivery-workspace-");
  process.env.HATCH_RUNTIME_DATA_DIR = await tempDirectory("hatch-tool-delivery-runtime-");
  await writeFile(path.join(workspace, "notes.txt"), "Hatch local evidence.\n", "utf8");
  const mock = await createPinnedToolHandoffMock();
  configureMockModels(mock.baseUrl);
  try {
    const entitlement = entitlementFor(releaseFixture.releaseId, releaseFixture.digest);
    const runtime = createRuntimeServer({
      releaseResolver: new CreatorReleaseResolver(releaseFixture.root),
      entitlementResolver: new MemoryEntitlementResolver("license_fixture", entitlement)
    });
    servers.push(runtime);
    const result = await runLocalHarness({
      serverUrl: await listen(runtime),
      workspace,
      prompt: "Find Hatch in local files and save the review to result.md.",
      licenseToken: "license_fixture",
      entitlementId: entitlement.entitlement_id,
      approveTool: () => true
    });

    assert.match(result.finalText, /LOCAL EVIDENCE FINAL/);
    assert.match(result.finalText, /Completed and saved the result to result\.md/);
    assert.equal(await readFile(path.join(workspace, "result.md"), "utf8"), "LOCAL EVIDENCE FINAL");
    assert.deepEqual(result.events.filter((event) => event.type === "tool_call.request").map((event) => event.name), ["fs.search", "fs.write"]);
    assert.deepEqual(mock.requests[1]?.tools, []);
  } finally {
    await mock.close();
  }
});

test("buyer entitlement discovers and runs its server-pinned Release through real local tools", async () => {
  const releaseFixture = await createReleaseFixture();
  const workspace = await tempDirectory("hatch-buyer-workspace-");
  process.env.HATCH_RUNTIME_DATA_DIR = await tempDirectory("hatch-buyer-runtime-");
  await writeFile(path.join(workspace, "brief.md"), "# Campaign brief\nMake the promise concrete and preserve evidence.", "utf8");

  const entitlement = entitlementFor(releaseFixture.releaseId, releaseFixture.digest);
  const entitlementResolver = new MemoryEntitlementResolver("lic_demo_jordan_lee", entitlement);
  const { ledger: commerceLedger, sink: commerceSink } = await openSeededCommerceLedger(entitlement);
  const runtime = createRuntimeServer({
    createRuntime: () => new DeterministicAgentRuntime(),
    releaseResolver: new CreatorReleaseResolver(releaseFixture.root),
    entitlementResolver,
    commerceEventSink: commerceSink
  });
  servers.push(runtime);
  const serverUrl = await listen(runtime);

  const libraryUrl = new URL(serverUrl);
  libraryUrl.protocol = "http:";
  libraryUrl.pathname = "/v1/me/creator-agents";
  const libraryResponse = await fetch(libraryUrl, { headers: { authorization: "Bearer lic_demo_jordan_lee" } });
  assert.equal(libraryResponse.status, 200);
  const library = await libraryResponse.json() as Record<string, any>;
  assert.equal(library.creator_agents[0].entitlement_id, entitlement.entitlement_id);
  assert.equal(library.creator_agents[0].product.name, "Signal Review");
  assert.deepEqual(library.creator_agents[0].product.offer, { model: "per_delivery", amount_minor: 3900, currency: "USD" });
  assert.equal("release_id" in library.creator_agents[0], false);
  assert.equal("release_digest" in library.creator_agents[0], false);

  const harnessOptions = {
    serverUrl,
    workspace,
    prompt: "Find \"Campaign\" and save the review to \"campaign-review.md\".",
    licenseToken: "lic_demo_jordan_lee",
    entitlementId: entitlement.entitlement_id,
    runIdFactory: () => "run_jordan_signal_001",
    conversationId: "conversation_jordan_signal_review"
  };
  const first = await runLocalHarness(harnessOptions);
  const receipt = first.events.find((event) => event.type === "delivery.ready");
  assert.ok(receipt && receipt.type === "delivery.ready");
  assert.match(receipt.task_id, /^task_[a-f0-9]{24}$/);
  assert.match(receipt.artifact_digest, /^sha256:[a-f0-9]{64}$/);
  const deliveredFile = await readFile(path.join(workspace, "campaign-review.md"));
  assert.match(deliveredFile.toString("utf8"), /Campaign brief/);
  assert.equal(receipt.artifact_type, "file");
  assert.equal(receipt.artifact_path, "campaign-review.md");
  assert.equal(receipt.artifact_digest, `sha256:${createHash("sha256").update(deliveredFile).digest("hex")}`);
  assert.deepEqual(first.events.filter((event) => event.type === "tool_call.request").map((event) => event.name), [
    "fs.search", "fs.read", "fs.write"
  ]);
  assert.equal(commerceLedger.listEvents().filter((event: Record<string, unknown>) => event.event_type === "delivery.completed").length, 1);
  assert.equal(commerceLedger.listEvents().filter((event: Record<string, unknown>) => event.event_type === "revenue.recognized").length, 1);

  await runtime.close();
  servers.splice(servers.indexOf(runtime), 1);
  const restartedRuntime = createRuntimeServer({
    createRuntime: () => new DeterministicAgentRuntime(),
    releaseResolver: new CreatorReleaseResolver(releaseFixture.root),
    entitlementResolver,
    commerceEventSink: commerceSink
  });
  servers.push(restartedRuntime);
  const restartedServerUrl = await listen(restartedRuntime);

  const second = await runLocalHarness({ ...harnessOptions, serverUrl: restartedServerUrl });
  const retryReceipt = second.events.find((event) => event.type === "delivery.ready");
  assert.ok(retryReceipt && retryReceipt.type === "delivery.ready");
  assert.equal(retryReceipt.task_id, receipt.task_id);
  assert.equal(retryReceipt.artifact_id, receipt.artifact_id);
  assert.equal(retryReceipt.delivery_id, receipt.delivery_id);
  assert.deepEqual(second.events.filter((event) => event.type === "tool_call.request"), []);
  assert.deepEqual(await readFile(path.join(workspace, "campaign-review.md")), deliveredFile);
  assert.equal(commerceLedger.listEvents().filter((event: Record<string, unknown>) => event.event_type === "delivery.completed").length, 1);
  const revenue = commerceLedger.listEvents().filter((event: Record<string, unknown>) => event.event_type === "revenue.recognized");
  assert.equal(revenue.length, 1);
  assert.equal(revenue[0].creator_share_minor, 3510);
  assert.equal(revenue[0].hatch_share_minor, 390);
});

test("another license cannot open Jordan's entitlement", async () => {
  const releaseFixture = await createReleaseFixture();
  const entitlement = entitlementFor(releaseFixture.releaseId, releaseFixture.digest);
  const runtime = createRuntimeServer({
    releaseResolver: new CreatorReleaseResolver(releaseFixture.root),
    entitlementResolver: new MemoryEntitlementResolver("lic_demo_jordan_lee", entitlement)
  });
  servers.push(runtime);
  const serverUrl = await listen(runtime);
  const url = new URL(serverUrl);
  url.protocol = "http:";
  url.pathname = "/v1/me/creator-agents";
  const response = await fetch(url, { headers: { authorization: "Bearer lic_someone_else" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { creator_agents: [] });
});

test("product-mode WebSocket rejects a client-asserted Release without entitlement", async () => {
  const releaseFixture = await createReleaseFixture();
  const entitlement = entitlementFor(releaseFixture.releaseId, releaseFixture.digest);
  const runtime = createRuntimeServer({
    releaseResolver: new CreatorReleaseResolver(releaseFixture.root),
    entitlementResolver: new MemoryEntitlementResolver("license_fixture", entitlement)
  });
  servers.push(runtime);
  const message = await firstSocketMessage(await listen(runtime), {
    type: "client.hello",
    protocol_version: "0.3",
    installation_id: "attacker-installation",
    license_token: "license_fixture",
    tenant_id: entitlement.tenant_id,
    user_id: entitlement.user_id,
    product_id: entitlement.product_id,
    release_id: entitlement.release_id,
    release_digest: entitlement.release_digest,
    local_tools: []
  });

  assert.equal(message.type, "turn.failed");
  assert.equal((message.error as Record<string, unknown>)?.code, "entitlement_required");
  assert.match(String((message.error as Record<string, unknown>)?.message), /entitlement is required/i);
});

test("partial product resolver configuration fails closed", async () => {
  const releaseFixture = await createReleaseFixture();
  const runtime = createRuntimeServer({
    releaseResolver: new CreatorReleaseResolver(releaseFixture.root)
  });
  servers.push(runtime);
  const message = await firstSocketMessage(await listen(runtime), {
    type: "client.hello",
    protocol_version: "0.3",
    installation_id: "local-installation",
    license_token: "local-license",
    product_id: "signal-review",
    release_id: releaseFixture.releaseId,
    release_digest: releaseFixture.digest,
    local_tools: []
  });

  assert.equal(message.type, "turn.failed");
  assert.equal((message.error as Record<string, unknown>)?.code, "entitlement_configuration_incomplete");
});

test("product-mode history rejects self-reported scope and invalid Bearer credentials", async () => {
  const releaseFixture = await createReleaseFixture();
  const entitlement = entitlementFor(releaseFixture.releaseId, releaseFixture.digest);
  const runtime = createRuntimeServer({
    releaseResolver: new CreatorReleaseResolver(releaseFixture.root),
    entitlementResolver: new MemoryEntitlementResolver("license_fixture", entitlement)
  });
  servers.push(runtime);
  const serverUrl = await listen(runtime);
  const historyUrl = new URL(serverUrl);
  historyUrl.protocol = "http:";
  historyUrl.pathname = "/conversations/conversation_jordan_signal_review/messages";
  historyUrl.searchParams.set("tenant_id", entitlement.tenant_id!);
  historyUrl.searchParams.set("user_id", entitlement.user_id);
  historyUrl.searchParams.set("product_id", entitlement.product_id);
  historyUrl.searchParams.set("release_id", entitlement.release_id!);
  historyUrl.searchParams.set("release_digest", entitlement.release_digest!);

  const selfAsserted = await fetch(historyUrl);
  assert.equal(selfAsserted.status, 403);
  assert.equal((await selfAsserted.json() as any).error.code, "entitlement_required");

  historyUrl.search = "";
  historyUrl.searchParams.set("entitlement_id", entitlement.entitlement_id);
  const invalidBearer = await fetch(historyUrl, { headers: { authorization: "Bearer wrong-license" } });
  assert.equal(invalidBearer.status, 403);
  assert.equal((await invalidBearer.json() as any).error.code, "entitlement_required");
});

test("entitlement-bound run materializes protected Skills and few-shots without eager RAG", async () => {
  const releaseFixture = await createReleaseFixture();
  const workspace = await tempDirectory("hatch-materialized-workspace-");
  process.env.HATCH_RUNTIME_DATA_DIR = await tempDirectory("hatch-materialized-runtime-");
  const entitlement = entitlementFor(releaseFixture.releaseId, releaseFixture.digest);
  const observed: { prompt?: string; tools?: string[] } = {};
  const runtime = createRuntimeServer({
    createRuntime: () => new ContextObservingRuntime(observed),
    releaseResolver: new CreatorReleaseResolver(releaseFixture.root),
    entitlementResolver: new MemoryEntitlementResolver("license_fixture", entitlement)
  });
  servers.push(runtime);
  const result = await runLocalHarness({
    serverUrl: await listen(runtime),
    workspace,
    prompt: "How should I treat the campaign evidence?",
    licenseToken: "license_fixture",
    entitlementId: entitlement.entitlement_id,
    localTools: ["fs.search", "fs.read", "fs.write", "fs.patch"]
  });

  assert.match(observed.prompt ?? "", /Apply the protected standards/);
  assert.match(observed.prompt ?? "", /PROTECTED-SKILL-INSTRUCTION/);
  assert.doesNotMatch(observed.prompt ?? "", /RAG-CAMPAIGN-EVIDENCE/);
  assert.match(observed.prompt ?? "", /FEW-SHOT-ANSWER/);
  assert.deepEqual(observed.tools, ["fs.search", "fs.read", "fs.write"]);
  assert.match(result.finalText, /materialized/);
});

class ContextObservingRuntime implements AgentRuntime {
  constructor(private readonly observed: { prompt?: string; tools?: string[] }) {}
  async *run(input: RunStart, ctx: RunContext): AsyncIterable<OutboundMessage> {
    this.observed.prompt = ctx.releaseSystemPrompt;
    this.observed.tools = [...ctx.clientTools];
    yield {
      type: "turn.completed",
      run_id: input.run_id,
      output: [{ type: "message", content: "Creator Release materialized." }],
      usage: { input_tokens: 1, output_tokens: 1 }
    };
  }
}

class MemoryEntitlementResolver implements EntitlementResolver {
  constructor(private readonly token: string, private readonly binding: EntitlementBinding) {}
  async list(input: EntitlementLookup): Promise<EntitlementBinding[]> {
    return input.licenseToken === this.token ? [this.binding] : [];
  }
  async resolve(input: EntitlementLookup & { entitlementId: string }): Promise<EntitlementBinding> {
    if (input.licenseToken !== this.token || input.entitlementId !== this.binding.entitlement_id) {
      throw new Error("entitlement_not_found");
    }
    return this.binding;
  }
}

function entitlementFor(releaseId: string, releaseDigest: string): EntitlementBinding {
  return {
    entitlement_id: "entitlement_jordan_signal_review",
    order_id: "order_jordan_signal_review",
    tenant_id: "tenant_hatch_demo",
    user_id: "buyer_jordan_lee",
    creator_id: "creator_maya_chen",
    product_id: "signal-review",
    release_id: releaseId,
    release_digest: releaseDigest,
    status: "active"
  };
}

async function openSeededCommerceLedger(entitlement: EntitlementBinding): Promise<{
  ledger: {
    append(type: string, payload: Record<string, unknown>, options: { idempotencyKey: string }): Promise<unknown>;
    listEvents(): Array<Record<string, unknown>>;
    findByIdempotencyKey(key: string): unknown;
  };
  sink: import("./delivery.js").CommerceEventSink;
}> {
  const module = await import(new URL("../../packages/commerce/src/index.js", import.meta.url).href);
  const ledger = await module.CommerceLedger.open();
  await ledger.append("order.placed", {
    order_id: entitlement.order_id,
    buyer_id: entitlement.user_id,
    creator_id: entitlement.creator_id,
    product_id: entitlement.product_id,
    release_id: entitlement.release_id,
    release_digest: entitlement.release_digest,
    gross_minor: 3900,
    currency: "USD"
  }, { idempotencyKey: `order:${entitlement.order_id}` });
  await ledger.append("entitlement.granted", {
    entitlement_id: entitlement.entitlement_id,
    order_id: entitlement.order_id,
    buyer_id: entitlement.user_id,
    creator_id: entitlement.creator_id,
    product_id: entitlement.product_id,
    release_id: entitlement.release_id,
    release_digest: entitlement.release_digest
  }, { idempotencyKey: `entitlement:${entitlement.entitlement_id}` });
  const recognizedSink = new module.LedgerCommerceSink(ledger);
  return {
    ledger,
    sink: {
      append: (type, payload, options) => recognizedSink.ingest(type, payload, options),
      findByIdempotencyKey: (key) => ledger.findByIdempotencyKey(key)
    }
  };
}

async function createReleaseFixture(withDeliveryWorkflow = false): Promise<{ root: string; releaseId: string; digest: string }> {
  const root = await tempDirectory("hatch-entitlement-release-");
  const releaseId = "signal-review@1.0.0";
  const skill = "---\nname: signal-review\ndescription: Review evidence using the Creator method.\n---\nRead the user's real files before producing a review.";
  const protectedSkill = `${skill}\nPROTECTED-SKILL-INSTRUCTION`;
  const skillDigest = digest(protectedSkill);
  const ragDocuments = JSON.stringify([{ id: "document-1", text: "RAG-CAMPAIGN-EVIDENCE: Preserve supplied campaign evidence." }]);
  const ragChunks = JSON.stringify([{ id: "chunk-1", text: "RAG-CAMPAIGN-EVIDENCE: Preserve supplied campaign evidence." }]);
  const publicBase: Omit<CreatorReleasePublic, "digest"> = {
    contract_version: "1",
    release_id: releaseId,
    product_id: "signal-review",
    creator_id: "creator_maya_chen",
    version: "1.0.0",
    creator: { id: "creator_maya_chen", name: "Maya Chen" },
    product: {
      name: "Signal Review",
      description: "A general workspace agent that reviews work using Maya's standards.",
      promise: "Turn evidence in your workspace into a useful review.",
      boundaries: ["Does not guarantee external outcomes."],
      price: { model: "per_delivery", amount_minor: 3900, currency: "USD" },
      supported_local_capabilities: ["fs.search", "fs.read", "fs.write"]
    },
    presentation: { accent: "coral" }
  };
  const privateBase: Omit<CreatorReleasePrivate, "digest"> = {
    contract_version: "1",
    release_id: releaseId,
    product_id: "signal-review",
    creator_id: "creator_maya_chen",
    version: "1.0.0",
    system_prompt: "Apply the protected standards to the user's actual workspace.",
    protected_skills: { root: "skills", assets: [{ id: "signal-review", path: "signal-review/SKILL.md", sha256: skillDigest }] },
    rag: { root: "rag", documents: [
      { id: "documents", path: "documents.json", sha256: digest(ragDocuments) },
      { id: "chunks", path: "chunks.json", sha256: digest(ragChunks) }
    ] },
    few_shots: [{ question: "What matters?", answer: "FEW-SHOT-ANSWER: preserve verifiable evidence." }],
    runtime_policy: {
      local_tools: ["fs.search", "fs.read", "fs.write"],
      external_tools: [],
      ...(withDeliveryWorkflow ? { delivery_workflow: deliveryWorkflowFixture() } : {})
    }
  };
  const releaseDigest = computeCreatorReleaseDigest(publicBase, privateBase);
  const releaseDirectory = path.join(root, releaseId, releaseDigest);
  await mkdir(path.join(releaseDirectory, "skills", "signal-review"), { recursive: true });
  await mkdir(path.join(releaseDirectory, "rag"), { recursive: true });
  await writeFile(path.join(releaseDirectory, "skills", "signal-review", "SKILL.md"), protectedSkill, "utf8");
  await writeFile(path.join(releaseDirectory, "rag", "documents.json"), ragDocuments, "utf8");
  await writeFile(path.join(releaseDirectory, "rag", "chunks.json"), ragChunks, "utf8");
  await writeFile(path.join(releaseDirectory, "public.json"), JSON.stringify({ ...publicBase, digest: releaseDigest }), "utf8");
  await writeFile(path.join(releaseDirectory, "private.json"), JSON.stringify({ ...privateBase, digest: releaseDigest }), "utf8");
  return { root, releaseId, digest: releaseDigest };
}

function deliveryWorkflowFixture(): Record<string, unknown> {
  return {
    version: "1",
    mode: "draft_claim_audit_revise",
    audit: {
      unit: "atomic_claim",
      verdicts: ["entailed", "unsupported", "conflicting", "confidential", "out_of_scope"],
      require_evidence_entailment: true,
      check_product_boundaries: true,
      coverage: {
        unitization: "markdown_claim_clauses_v1",
        require_all_units: true,
        max_units: 200
      },
      evidence_authority: {
        user_fact_sources: ["user_input", "approved_tool_evidence"],
        creator_method_sources: ["protected_knowledge"],
        protected_knowledge_cannot_support_user_specific_claims: true
      }
    },
    audit_instruction: "FACTORY_AUDIT_INSTRUCTION",
    revision_instruction: "FACTORY_REVISION_INSTRUCTION",
    audit_result_format: {
      claims: [{ unit_id: "string from claim_inventory", claim: "string", verdict: "entailed|unsupported|conflicting|confidential|out_of_scope", evidence: "string" }]
    },
    max_revision_passes: 2,
    on_unresolved: "return_boundary_safe_partial",
    expose_intermediate: false
  };
}

function configureMockModels(baseUrl: string): void {
  process.env.LLM_API_KEY = "kimi-key";
  process.env.OPENAI_BASE_URL = baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_REVIEWER_MODEL = "kimi-k2.6";
  process.env.HATCH_RUNTIME_DELIVERY_AUDIT = "enforce";
}

async function createDeliveryAuditMock(mode: "revise" | "safe_partial" | "compatibility" | "coverage_gap" | "coverage_batches" | "malformed_then_valid" | "schema_unsupported_then_json"): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  let creatorRequestCount = 0;
  let reviewerResponseCount = 0;
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
      requests.push(request);

      if (request.response_format?.type === "json_object") {
        reviewerResponseCount += 1;
        if (mode === "schema_unsupported_then_json" && request.response_format?.type === "json_schema") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "response_format json_schema is not supported" } }));
          return;
        }
        if (mode === "malformed_then_valid" && reviewerResponseCount === 1) {
          writeJsonModelCompletion(res, "{malformed");
          return;
        }
        const payload = JSON.parse(String(request.messages?.[1]?.content ?? "{}"));
        const draft = String(payload.draft_deliverable ?? "");
        const passed = draft.startsWith("SAFE");
        const inventory = Array.isArray(payload.claim_inventory) ? payload.claim_inventory : [];
        const reviewedInventory = mode === "coverage_gap" && draft.includes("UNSUPPORTED SECOND")
          ? inventory.slice(0, 1)
          : inventory;
        writeJsonModelCompletion(res, JSON.stringify({
          claims: reviewedInventory.map((unit: Record<string, unknown>) => ({
            unit_id: unit.unit_id,
            claim: unit.text || draft || "empty",
            verdict: passed ? "entailed" : "unsupported",
            evidence: passed ? "supplied evidence" : "not found in supplied evidence"
          }))
        }));
        return;
      }

      const isRevision = Array.isArray(request.messages)
        && request.messages.some((message: Record<string, unknown>) => String(message.content ?? "").includes("FACTORY_REVISION_INSTRUCTION"));
      if (!isRevision) {
        creatorRequestCount += 1;
        if (mode === "compatibility") {
          writeCreatorTextCompletion(res, request.stream === true, "LEGACY STREAM");
        } else if (mode === "revise" && creatorRequestCount === 1) {
          writeCreatorToolCall(res, request.stream === true, "call_unsafe", "file_write", { path: "result.md", content: "UNSAFE FILE" });
        } else if (mode === "revise" && creatorRequestCount === 2) {
          writeCreatorToolCall(res, request.stream === true, "call_safe", "file_write", { path: "result.md", content: "SAFE FILE" });
        } else if (mode === "coverage_gap") {
          writeCreatorTextCompletion(res, request.stream === true, "SAFE FIRST. UNSUPPORTED SECOND.");
        } else if (mode === "coverage_batches") {
          writeCreatorTextCompletion(res, request.stream === true, coverageBatchDraft());
        } else if (mode === "malformed_then_valid" || mode === "schema_unsupported_then_json") {
          writeCreatorTextCompletion(res, request.stream === true, "SAFE FINAL");
        } else {
          writeCreatorTextCompletion(res, request.stream === true, "UNSAFE FINAL");
        }
        return;
      }

      const revisionPayload = JSON.parse(String(request.messages?.[1]?.content ?? "{}"));
      if (mode === "safe_partial" && revisionPayload.boundary_safe_partial_requested === true) {
        writeJsonModelCompletion(res, "SAFE PARTIAL");
      } else if (mode === "safe_partial") {
        writeJsonModelCompletion(res, "UNSAFE REVISION");
      } else if (mode === "coverage_gap") {
        writeJsonModelCompletion(res, "SAFE COVERED");
      } else {
        writeJsonModelCompletion(res, "SAFE FINAL");
      }
    })().catch((error) => {
      res.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected mock TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function createPinnedToolHandoffMock(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
      requests.push(request);
      if (requests.length === 1) {
        assert.equal(request.stream, true);
        writeSseToolCall(res, "call_local_search", "file_search", {
          query: "Hatch",
          path: ".",
          max_results: 5
        });
        return;
      }
      assert.equal(requests.length, 2);
      assert.equal(request.stream, false);
      writeJsonModelCompletion(res, "LOCAL EVIDENCE FINAL");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected mock TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function coverageBatchDraft(): string {
  return Array.from({ length: 21 }, (_, index) => `SAFE claim ${index + 1}.`).join(" ");
}

function writeJsonModelCompletion(res: http.ServerResponse, content: string): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "chatcmpl_test",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }]
  }));
}

function writeSseModelCompletion(res: http.ServerResponse, content: string): void {
  writeSseChunks(res, [{ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] }]);
}

function writeCreatorTextCompletion(res: http.ServerResponse, streamed: boolean, content: string): void {
  if (streamed) writeSseModelCompletion(res, content);
  else writeJsonModelCompletion(res, content);
}

function writeCreatorToolCall(
  res: http.ServerResponse,
  streamed: boolean,
  id: string,
  name: string,
  args: Record<string, unknown>
): void {
  if (streamed) {
    writeSseToolCall(res, id, name, args);
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "chatcmpl_test",
    object: "chat.completion",
    choices: [{
      index: 0,
      message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
      finish_reason: "tool_calls"
    }]
  }));
}

function writeSseToolCall(res: http.ServerResponse, id: string, name: string, args: Record<string, unknown>): void {
  writeSseChunks(res, [{
    choices: [{
      index: 0,
      delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
      finish_reason: "tool_calls"
    }]
  }]);
}

function writeSseChunks(res: http.ServerResponse, chunks: Array<Record<string, unknown>>): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function listen(runtime: RuntimeServer): Promise<string> {
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return `ws://127.0.0.1:${address.port}/runtime`;
}

async function firstSocketMessage(serverUrl: string, hello: Record<string, unknown>): Promise<Record<string, any>> {
  const socket = new WebSocket(serverUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const received = new Promise<Record<string, any>>((resolve, reject) => {
      socket.once("message", (data) => resolve(JSON.parse(String(data))));
      socket.once("error", reject);
    });
    socket.send(JSON.stringify(hello));
    return await received;
  } finally {
    socket.close();
  }
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
