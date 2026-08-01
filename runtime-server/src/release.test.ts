import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { WebSocket } from "ws";
import type { EntitlementBinding, EntitlementLookup, EntitlementResolver } from "./entitlements.js";
import { createRuntimeServer, protectPrivateReleaseBoundary, scopedConversationId } from "./index.js";
import { CreatorReleaseResolver, computeCreatorReleaseDigest, type CreatorReleasePrivate, type CreatorReleasePublic } from "./release.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("resolves an immutable Creator Release by release_id and digest", async () => {
  const fixture = await createReleaseFixture();
  const resolved = await new CreatorReleaseResolver(fixture.root).resolve(fixture.releaseId, fixture.digest);
  assert.equal(resolved.public.product.name, "Signal Resume Review");
  assert.match(resolved.private.system_prompt, /Maya/);
  assert.equal("synthetic_qa" in resolved.private, false);
  assert.equal("evals" in resolved.private, false);
  assert.equal(await readFile(path.join(resolved.protectedSkillsRoot, "signal-resume", "SKILL.md"), "utf8"), fixture.skillContent);
});

test("rejects a Creator Release whose manifest or private asset no longer matches its digest", async () => {
  const manifestFixture = await createReleaseFixture();
  const privatePath = path.join(manifestFixture.releaseDir, "private.json");
  const privateRelease = JSON.parse(await readFile(privatePath, "utf8")) as CreatorReleasePrivate;
  privateRelease.system_prompt = "tampered private prompt";
  await writeFile(privatePath, JSON.stringify(privateRelease), "utf8");
  await assert.rejects(
    new CreatorReleaseResolver(manifestFixture.root).resolve(manifestFixture.releaseId, manifestFixture.digest),
    /Creator Release digest mismatch/
  );

  const assetFixture = await createReleaseFixture();
  await writeFile(path.join(assetFixture.releaseDir, "skills", "signal-resume", "SKILL.md"), "tampered skill", "utf8");
  await assert.rejects(
    new CreatorReleaseResolver(assetFixture.root).resolve(assetFixture.releaseId, assetFixture.digest),
    /Private asset digest mismatch/
  );
});

test("rejects undeclared files instead of materializing a dirty Creator Release", async () => {
  const fixture = await createReleaseFixture();
  await mkdir(path.join(fixture.releaseDir, "review"), { recursive: true });
  await writeFile(path.join(fixture.releaseDir, "review", "evals.json"), "[]", "utf8");
  await assert.rejects(
    new CreatorReleaseResolver(fixture.root).resolve(fixture.releaseId, fixture.digest),
    /file shape mismatch.*review\/evals\.json/
  );
});

test("tenant/release binding isolates identical conversation ids", () => {
  const common = { userId: "buyer", productId: "product", releaseId: "release", releaseDigest: `sha256:${"a".repeat(64)}` };
  const tenantA = scopedConversationId({ ...common, tenantId: "tenant-a" }, "conversation-1");
  const tenantB = scopedConversationId({ ...common, tenantId: "tenant-b" }, "conversation-1");
  const anotherRelease = scopedConversationId({ ...common, tenantId: "tenant-a", releaseDigest: `sha256:${"b".repeat(64)}` }, "conversation-1");
  assert.notEqual(tenantA, tenantB);
  assert.notEqual(tenantA, anotherRelease);
});

test("session-ready exposes only public binding and never server-private Release assets", async () => {
  const fixture = await createReleaseFixture();
  const entitlement: EntitlementBinding = {
    entitlement_id: "entitlement-jordan-signal",
    order_id: "order-jordan-signal",
    tenant_id: "tenant-jordan",
    user_id: "jordan",
    creator_id: "maya",
    product_id: "signal-resume",
    release_id: fixture.releaseId,
    release_digest: fixture.digest,
    status: "active"
  };
  const runtime = createRuntimeServer({
    releaseResolver: new CreatorReleaseResolver(fixture.root),
    entitlementResolver: new SingleEntitlementResolver("local-license", entitlement)
  });
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/runtime`);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const ready = new Promise<Record<string, unknown>>((resolve) => socket.once("message", (data) => resolve(JSON.parse(String(data)))));
  socket.send(JSON.stringify({
    type: "client.hello", protocol_version: "0.3", installation_id: "install-jordan", license_token: "local-license",
    entitlement_id: entitlement.entitlement_id, local_tools: []
  }));
  const message = await ready;
  assert.equal(message.type, "session.ready");
  assert.equal(message.release_digest, fixture.digest);
  assert.deepEqual(message.creator_agent, {
    creator: { id: "maya", name: "Maya Chen" },
    product: {
      id: "signal-resume",
      name: "Signal Resume Review",
      description: "Evidence review",
      promise: "Review evidence using Maya's method",
      boundaries: ["No interview guarantee"],
      offer: { model: "per_delivery", amount_minor: 3900, currency: "USD" }
    },
    presentation: { accent: "blue" }
  });
  const serialized = JSON.stringify(message);
  assert.doesNotMatch(serialized, /Maya's protected method|synthetic_qa|runtime_policy|SKILL\.md/);
  socket.close();
  await runtime.close();
});

class SingleEntitlementResolver implements EntitlementResolver {
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

test("outbound event sanitizer removes private Release paths and tool results", async () => {
  const fixture = await createReleaseFixture();
  const release = await new CreatorReleaseResolver(fixture.root).resolve(fixture.releaseId, fixture.digest);
  const activated = protectPrivateReleaseBoundary({
    type: "skill.activated", run_id: "run", name: "signal-resume",
    path: path.join(release.protectedSkillsRoot, "signal-resume", "SKILL.md"), scope: "admin", status: "activated",
    invocation_type: "explicit", reason: "explicit_mention", resource_paths: ["secret-rubric.md"], resource_manifest_truncated: false
  }, release);
  assert.doesNotMatch(JSON.stringify(activated), /SKILL\.md|secret-rubric|hatch-release-/);

  const tool = protectPrivateReleaseBoundary({
    type: "tool_call.delta", run_id: "run", tool_call_id: "call", name: "file.read", locality: "server", approval: "none",
    status: "completed", arguments: { path: path.join(release.protectedSkillsRoot, "signal-resume", "SKILL.md") },
    result: { content: "Maya's secret rubric" }
  }, release);
  assert.deepEqual("result" in tool ? tool.result : undefined, { private_result_redacted: true });
  assert.doesNotMatch(JSON.stringify(tool), /secret rubric|SKILL\.md|hatch-release-/);
});

async function createReleaseFixture(): Promise<{ root: string; releaseDir: string; releaseId: string; digest: string; skillContent: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-release-"));
  tempDirs.push(root);
  const releaseId = "signal-resume@1.0.0";
  const skillContent = "---\nname: signal-resume\ndescription: Protected review workflow.\n---\nUse Maya's rubric.";
  const skillDigest = digest(skillContent);
  const documents = "[]";
  const chunks = "[]";
  const publicBase: Omit<CreatorReleasePublic, "digest"> = {
    contract_version: "1" as const, release_id: releaseId, product_id: "signal-resume", creator_id: "maya", version: "1.0.0",
    creator: { id: "maya", name: "Maya Chen" },
    product: { name: "Signal Resume Review", description: "Evidence review", promise: "Review evidence using Maya's method", boundaries: ["No interview guarantee"], price: { model: "per_delivery", amount_minor: 3900, currency: "USD" }, supported_local_capabilities: ["fs.read"] },
    presentation: { accent: "blue" }
  };
  const privateBase: Omit<CreatorReleasePrivate, "digest"> = {
    contract_version: "1" as const, release_id: releaseId, product_id: "signal-resume", creator_id: "maya", version: "1.0.0",
    system_prompt: "Follow Maya's protected method.",
    protected_skills: { root: "skills", assets: [{ id: "signal-resume", path: "signal-resume/SKILL.md", sha256: skillDigest }] },
    rag: { root: "rag", documents: [
      { id: "documents", path: "documents.json", sha256: digest(documents) },
      { id: "chunks", path: "chunks.json", sha256: digest(chunks) }
    ] }, few_shots: [], runtime_policy: { local_tools: ["fs.read"] }
  };
  const digestValue = computeCreatorReleaseDigest(publicBase, privateBase);
  const releaseDir = path.join(root, releaseId, digestValue);
  await mkdir(path.join(releaseDir, "skills", "signal-resume"), { recursive: true });
  await mkdir(path.join(releaseDir, "rag"), { recursive: true });
  await writeFile(path.join(releaseDir, "skills", "signal-resume", "SKILL.md"), skillContent, "utf8");
  await writeFile(path.join(releaseDir, "rag", "documents.json"), documents, "utf8");
  await writeFile(path.join(releaseDir, "rag", "chunks.json"), chunks, "utf8");
  await writeFile(path.join(releaseDir, "public.json"), JSON.stringify({ ...publicBase, digest: digestValue }), "utf8");
  await writeFile(path.join(releaseDir, "private.json"), JSON.stringify({ ...privateBase, digest: digestValue }), "utf8");
  return { root, releaseDir, releaseId, digest: digestValue, skillContent };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
