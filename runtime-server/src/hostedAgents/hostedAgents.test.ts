import assert from "node:assert/strict";
import test from "node:test";
import { HostedIngest, exposeProfile, platformsFor } from "./ingest.js";
import { KimiHostedAgent } from "./kimiHostedAgent.js";
import { Provisioner, reconcile, specDigest } from "./provisioner.js";
import type { AgentSpec, BrowserProfile, BrowserProfileStore, HostedAgentProvider, HostedTask, KimiHostedApi, Owned, ProfileLease, SandboxSpec } from "./ports.js";

const sandbox: SandboxSpec = { name: "box", packages: { apt: ["xvfb"] }, setupScript: "true", networking: { type: "unrestricted" } };
const agent: AgentSpec = { name: "agent", model: "kimi-k3.1-pro", system: "s", skills: [{ name: "sk", dir: "/skills/sk" }] };

/** A fake provider that records calls and replays a scripted event stream. */
function fakeApi(events: Array<{ type: string; data: Record<string, unknown> }> = [], artifacts: Record<string, string> = {}) {
  const calls: string[] = [];
  const environments = new Map<string, Owned>(); const agents = new Map<string, Owned>();
  const api: KimiHostedApi = {
    findEnvironment: async name => { calls.push(`findEnvironment ${name}`); const e = environments.get(name); return e && { ...e, buildStatus: "ready" }; },
    createEnvironment: async (spec, description) => { calls.push("createEnvironment"); const e = { id: "env_1", name: spec.name, description }; environments.set(spec.name, e); return e; },
    updateEnvironment: async (id, spec, description) => { calls.push("updateEnvironment"); const e = { id, name: spec.name, description }; environments.set(spec.name, e); return e; },
    environmentStatus: async () => ({ buildStatus: "ready" }),
    uploadSkill: async name => { calls.push(`uploadSkill ${name}`); return { id: "skill_1", version: "1" }; },
    findAgent: async name => agents.get(name),
    createAgent: async (spec, skills, description) => { calls.push(`createAgent ${skills.map(s => s.id)}`); const a = { id: "agent_1", name: spec.name, description }; agents.set(spec.name, a); return a; },
    updateAgent: async (id, spec, _skills, description) => { calls.push("updateAgent"); const a = { id, name: spec.name, description }; agents.set(spec.name, a); return a; },
    createVault: async () => { calls.push("createVault"); return { id: "vlt_1" }; },
    addSecret: async (_v, secret) => { calls.push(`addSecret ${secret.name} ${secret.hosts.join(",")}`); },
    deleteVault: async () => { calls.push("deleteVault"); },
    uploadFile: async file => { calls.push(`uploadFile ${file.name}`); return { id: `file_${file.name}` }; },
    deleteFile: async id => { calls.push(`deleteFile ${id}`); },
    createSession: async input => { calls.push(`createSession ${input.fileIds.length} ${input.vaultIds.join(",")}`); return { id: "sesn_1" }; },
    sendMessage: async () => { calls.push("sendMessage"); },
    events: async function* () { let i = 0; for (const e of events) yield { cursor: String(++i), ...e }; },
    listArtifacts: async () => Object.keys(artifacts).map(name => ({ id: `arti_${name}`, name })),
    downloadArtifact: async id => Buffer.from(artifacts[id.replace(/^arti_/, "")]!),
    archiveSession: async () => { calls.push("archiveSession"); },
  };
  return { api, calls };
}

const pack = async (dir: string) => Buffer.from(`zip of ${dir}`);
const finished = (message: string) => [
  { type: "session.status", data: { status: "idle" } },
  { type: "session.status", data: { status: "running" } },
  { type: "agent.message", data: { content: [{ type: "text", text: message }] } },
  { type: "session.status", data: { status: "idle" } },
];

test("Digests ignore key order and change with content", () => {
  assert.equal(specDigest({ a: 1, b: [1, { c: 2, d: 3 }] }), specDigest({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(specDigest({ a: 1 }), specDigest({ a: 2 }));
});

test("Reconcile creates, then reuses, then updates when the declaration moves", async () => {
  const store = new Map<string, Owned>(); const log: string[] = [];
  const ensure = reconcile<{ name: string }>({
    find: async name => store.get(name),
    create: async (spec, description) => { log.push("create"); const o = { id: "1", name: spec.name, description }; store.set(spec.name, o); return o; },
    update: async (id, spec, description) => { log.push("update"); const o = { id, name: spec.name, description }; store.set(spec.name, o); return o; },
  });
  await ensure({ name: "x" }, "d1"); await ensure({ name: "x" }, "d1"); await ensure({ name: "x" }, "d2");
  assert.deepEqual(log, ["create", "update"]);
});

test("Provisioning is memoized and skills upload only when the agent must change", async () => {
  const { api, calls } = fakeApi();
  const provisioner = new Provisioner(api, sandbox, agent, pack);
  assert.deepEqual(await provisioner.ensure(), { environmentId: "env_1", agentId: "agent_1" });
  await provisioner.ensure();
  assert.deepEqual(calls.filter(c => !c.startsWith("find")), ["createEnvironment", "uploadSkill sk", "createAgent skill_1"]);
  calls.length = 0;
  await new Provisioner(api, sandbox, agent, pack).ensure();
  assert.deepEqual(calls.filter(c => !c.startsWith("find")), [], "a fresh process with the same declaration changes nothing");
});

test("A run mounts files and secrets, reads the final message, collects artifacts and cleans up", async () => {
  const { api, calls } = fakeApi(finished("done"), { "result.json": "{}" });
  const runner = new KimiHostedAgent(api, new Provisioner(api, sandbox, agent, pack));
  const result = await runner.run({ title: "t", prompt: "p", files: [{ name: "a.txt", bytes: Buffer.from("a") }], secrets: [{ name: "K", value: "v", hosts: ["h.com"] }] });
  assert.equal(result.status, "done");
  assert.equal(result.text, "done");
  assert.deepEqual(result.artifacts.map(a => a.name), ["result.json"]);
  for (const step of ["addSecret K h.com", "createSession 1 vlt_1", "archiveSession", "deleteFile file_a.txt", "deleteVault"]) assert.ok(calls.includes(step), step);
  assert.ok(calls.indexOf("archiveSession") < calls.indexOf("deleteVault"), "newest resources are cleaned up first");
});

test("A run that ends in an error is reported as failed, and still cleans up", async () => {
  const { api, calls } = fakeApi([{ type: "session.status", data: { status: "running" } }, { type: "session.error", data: { error: { message: "boom" } } }]);
  const result = await new KimiHostedAgent(api, new Provisioner(api, sandbox, agent, pack)).run({ title: "t", prompt: "p", files: [], secrets: [] });
  assert.equal(result.status, "failed");
  assert.equal(result.error, "boom");
  assert.ok(calls.includes("archiveSession"));
  assert.ok(!calls.includes("createVault"), "no secrets, no vault");
});

const profile = (over: Partial<BrowserProfile> = {}): BrowserProfile => ({
  id: "11111111-2222-3333-4444-555555555555", accountId: "acct", platform: "xiaohongshu", label: "main",
  hosts: ["xiaohongshu.com", "*.xiaohongshu.com"],
  cookies: [{ name: "web_session", value: "REAL", domain: ".xiaohongshu.com", path: "/" }],
  fingerprint: { userAgent: "UA", locale: "zh-CN", timezone: "Asia/Shanghai", viewport: { width: 1280, height: 900 } },
  status: "ready", updatedAt: "2026-11-07T00:00:00Z", ...over,
});

test("Only platforms covering a link in the batch are needed", () => {
  const items = [{ id: "1", kind: "link" as const, url: "https://www.xiaohongshu.com/explore/abc" }, { id: "2", kind: "file" as const, name: "a.pdf", bytes: Buffer.alloc(0) }];
  assert.deepEqual(platformsFor(items, [profile(), profile({ id: "x", platform: "douyin", hosts: ["*.douyin.com"] })]), ["xiaohongshu"]);
});

test("Exposed profiles carry no secret values, only placeholders scoped to their hosts", () => {
  const { secrets, manifest } = exposeProfile({ profile: profile({ proxy: "http://u:p@proxy.example.com:8000" }), leaseId: "l", expiresAt: "" });
  assert.ok(!JSON.stringify(manifest).includes("REAL") && !JSON.stringify(manifest).includes("u:p"));
  assert.deepEqual(secrets.map(s => [s.name, s.hosts]), [["HATCH_CK_11111111_0", ["xiaohongshu.com", "*.xiaohongshu.com"]], ["HATCH_PX_11111111", ["proxy.example.com"]]]);
  assert.equal(manifest.cookies[0]!.value_env, "HATCH_CK_11111111_0");
});

function fakeProfiles(initial: BrowserProfile[]) {
  const released: Array<{ leaseId: string; outcome: unknown }> = [];
  const store: BrowserProfileStore = {
    put: async () => { throw new Error("unused"); },
    list: async () => initial,
    lease: async (_a, platforms) => initial.filter(p => platforms.includes(p.platform)).map(p => ({ profile: p, leaseId: `lease-${p.id}`, expiresAt: "" } satisfies ProfileLease)),
    release: async (leaseId, outcome) => { released.push({ leaseId, outcome }); },
    remove: async () => undefined,
  };
  return { store, released };
}

test("Ingest maps the skill's result to items and writes refreshed cookies back to the profile", async () => {
  const p = profile();
  const { store, released } = fakeProfiles([p]);
  let task: HostedTask | undefined;
  const agentRun: HostedAgentProvider = {
    run: async t => {
      task = t;
      return {
        sessionId: "s", status: "done", text: "report",
        artifacts: [
          { name: "result.json", bytes: Buffer.from(JSON.stringify({ items: [{ id: "i1", status: "ok", original: "i1.original.mp4", markdown: "i1.content.md" }], profiles: [{ id: p.id, status: "ready" }] })) },
          { name: "i1.original.mp4", bytes: Buffer.from("video") },
          { name: "i1.content.md", bytes: Buffer.from("# hi") },
          { name: `profile.${p.id}.json`, bytes: Buffer.from(JSON.stringify({ cookies: [{ name: "web_session", value: "NEW", domain: ".xiaohongshu.com", path: "/" }] })) },
        ],
      };
    },
  };
  const outcome = await new HostedIngest(agentRun, store, [{ name: "DASHSCOPE_API_KEY", value: "k", hosts: ["dashscope.aliyuncs.com"] }])
    .ingest({ accountId: "acct", context: "", items: [{ id: "i1", kind: "link", url: "https://www.xiaohongshu.com/explore/abc" }, { id: "i2", kind: "file", name: "a.pdf", bytes: Buffer.from("%PDF") }] });
  assert.deepEqual(outcome.items.map(i => [i.id, i.status, i.original?.name, i.markdown]), [["i1", "ok", "i1.original.mp4", "# hi"], ["i2", "failed", undefined, undefined]]);
  assert.deepEqual(task!.files.map(f => f.name), ["task.json", "browser-profiles.json", "a.pdf"]);
  assert.deepEqual(task!.secrets.map(s => s.name), ["DASHSCOPE_API_KEY", "HATCH_CK_11111111_0"]);
  assert.deepEqual(released, [{ leaseId: `lease-${p.id}`, outcome: { status: "ready", cookies: [{ name: "web_session", value: "NEW", domain: ".xiaohongshu.com", path: "/" }] } }]);
});

test("A run without a verdict hands leased profiles back unchanged", async () => {
  const { store, released } = fakeProfiles([profile()]);
  const failing: HostedAgentProvider = { run: async () => ({ sessionId: "s", status: "failed", text: "", artifacts: [], error: "sandbox died" }) };
  await assert.rejects(new HostedIngest(failing, store).ingest({ accountId: "acct", context: "", items: [{ id: "i1", kind: "link", url: "https://xiaohongshu.com/a" }] }), /sandbox died/);
  assert.deepEqual(released, [{ leaseId: `lease-${profile().id}`, outcome: { status: "ready" } }]);
});
