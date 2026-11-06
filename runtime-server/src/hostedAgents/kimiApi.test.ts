import assert from "node:assert/strict";
import test from "node:test";
import { KimiApi } from "./kimiApi.js";
import { KimiApiError } from "./http.js";
import { sseFrames } from "./sse.js";
import type { AgentSpec, SandboxSpec } from "./ports.js";

const KEY = "sk-secret-key";
type Seen = { method: string; url: string; headers: Headers; body?: BodyInit | null; signal?: AbortSignal | null };
type Reply = Response | ((seen: Seen) => Response);

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const empty = (status = 204) => new Response(null, { status });

/** An API whose fetch answers from a queue and records what it was asked. */
function setup(...replies: Reply[]) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const entry = { method: init.method ?? "GET", url: String(input), headers: new Headers(init.headers), body: init.body, signal: init.signal };
    seen.push(entry);
    const reply = replies.shift();
    assert.ok(reply, `unexpected request ${entry.method} ${entry.url}`);
    return typeof reply === "function" ? reply(entry) : reply;
  }) as typeof fetch;
  return { api: new KimiApi({ apiKey: KEY, fetch: fetchImpl, retryDelayMs: 1 }), seen };
}

const body = (seen: Seen) => JSON.parse(seen.body as string);
const sandbox: SandboxSpec = { name: "env", packages: { pip: ["x"] }, setupScript: "echo", networking: { type: "limited", allowedHosts: ["a.com"] } };
const agent: AgentSpec = { name: "ag", model: "kimi-k3.1-pro", system: "sys", skills: [] };

test("every request carries the key and the API version, against the default base URL", async () => {
  const { api, seen } = setup(json({ items: [] }));
  await api.findAgent("x");
  assert.equal(seen[0].url, "https://api.moonshot.cn/v1/agents?page_size=100");
  assert.equal(seen[0].headers.get("authorization"), `Bearer ${KEY}`);
  assert.equal(seen[0].headers.get("kimi-api-version"), "2026-09-01-beta");
});

test("findEnvironment pages through the list and skips official resources of the same name", async () => {
  const { api, seen } = setup(
    json({ items: [{ id: "env_o", name: "env", scope: "official", build_status: "ready" }], next_page_token: "t2" }),
    json({ items: [{ id: "env_1", name: "env", description: "d", scope: "project", build_status: "building" }] }),
  );
  assert.deepEqual(await api.findEnvironment("env"), { id: "env_1", name: "env", description: "d", buildStatus: "building" });
  assert.match(seen[1].url, /page_token=t2/);
  const none = setup(json({ items: [] }));
  assert.equal(await none.api.findEnvironment("env"), undefined);
});

test("environments are created, updated and polled with the config shape", async () => {
  const { api, seen } = setup(json({ id: "env_1", name: "env" }, 201), json({ id: "env_1", name: "env" }), json({ build_status: "ready" }), json({ build_status: "failed" }));
  await api.createEnvironment(sandbox, "desc");
  assert.deepEqual(body(seen[0]), {
    name: "env",
    description: "desc",
    config: { type: "cloud", networking: { type: "limited", allowed_hosts: ["a.com"] }, packages: { apt: [], pip: ["x"], npm: [] }, setup_script: "echo" },
  });
  await api.updateEnvironment("env_1", { ...sandbox, networking: { type: "unrestricted" } }, "d2");
  assert.equal(seen[1].method, "PATCH");
  assert.equal(seen[1].url, "/environments/env_1".replace(/^/, "https://api.moonshot.cn/v1"));
  assert.deepEqual(body(seen[1]).config.networking, { type: "unrestricted" });
  assert.deepEqual(await api.environmentStatus("env_1"), { buildStatus: "ready" });
  assert.equal((await api.environmentStatus("env_1")).buildStatus, "failed");
});

test("uploadSkill sends the zip as multipart and returns id and version", async () => {
  const { api, seen } = setup(json({ skill: { id: "sk1" }, version: { version: "1" } }, 201));
  assert.deepEqual(await api.uploadSkill("pdf", Buffer.from("zip")), { id: "sk1", version: "1" });
  const file = (seen[0].body as FormData).get("file") as File;
  assert.equal(file.name, "pdf.zip");
  assert.equal(await file.text(), "zip");
});

test("uploadSkill on a name conflict archives the old skill and uploads again", async () => {
  const { api, seen } = setup(
    json({ error: { type: "conflict_error", message: "exists" } }, 409),
    json({ items: [{ id: "official", name: "pdf", scope: "official" }, { id: "old", name: "pdf", scope: "project" }] }),
    empty(),
    json({ skill: { id: "new" }, version: { version: "1" } }, 201),
  );
  assert.deepEqual(await api.uploadSkill("pdf", Buffer.from("zip")), { id: "new", version: "1" });
  assert.equal(seen[2].url, "https://api.moonshot.cn/v1/skills/old/archive");
});

test("agents are found by name, then created and updated with skills bound by id and version", async () => {
  const skills = [{ id: "sk1", version: "2" }];
  const { api, seen } = setup(json({ items: [{ id: "a1", name: "ag", scope: "project" }] }), json({ id: "a1", name: "ag" }, 201), json({ id: "a1", name: "ag" }));
  assert.deepEqual(await api.findAgent("ag"), { id: "a1", name: "ag", description: undefined });
  await api.createAgent(agent, skills, "d");
  assert.deepEqual(body(seen[1]), {
    name: "ag", description: "d", model: { id: "kimi-k3.1-pro" }, system: "sys",
    tools: [{ type: "agent_toolset", name: "default_toolset_20260901" }],
    skills: [{ skill_id: "sk1", version: "2" }],
  });
  await api.updateAgent("a1", agent, [], "d");
  assert.equal(seen[2].method, "PATCH");
  assert.deepEqual(body(seen[2]).skills, []);
});

test("vault: create, add a secret as an environment variable limited to its hosts, delete archives first", async () => {
  const { api, seen } = setup(json({ id: "v1" }, 201), json({ id: "c1" }, 201), empty(), empty());
  assert.deepEqual(await api.createVault("run"), { id: "v1" });
  assert.deepEqual(body(seen[0]), { display_name: "run" });
  await api.addSecret("v1", { name: "TOKEN", value: "val", hosts: ["x.com"] });
  assert.deepEqual(body(seen[1]), { display_name: "TOKEN", auth: { type: "environment_variable", secret_name: "TOKEN", secret_value: "val", networking: { type: "limited", allowed_hosts: ["x.com"] } } });
  await api.deleteVault("v1");
  assert.deepEqual(seen.slice(2).map(s => `${s.method} ${s.url.replace("https://api.moonshot.cn/v1", "")}`), ["POST /vaults/v1/archive", "DELETE /vaults/v1"]);
});

test("files upload as multipart under their own name and delete by id", async () => {
  const { api, seen } = setup(json({ id: "f1" }, 201), empty());
  assert.deepEqual(await api.uploadFile({ name: "a.txt", bytes: Buffer.from("hi"), mimeType: "text/plain" }), { id: "f1" });
  const file = (seen[0].body as FormData).get("file") as File;
  assert.equal(file.name, "a.txt");
  assert.equal(file.type, "text/plain");
  await api.deleteFile("f1");
  assert.equal(seen[1].method, "DELETE");
});

test("sessions bind files and vaults, take a user message, list and download artifacts, and archive", async () => {
  const { api, seen } = setup(json({ id: "s1" }, 201), json({}, 202), json({ items: [{ id: "ar1", name: "out.md", size_bytes: 2 }] }), new Response(new Uint8Array([1, 2, 3])), empty());
  assert.deepEqual(await api.createSession({ agentId: "a", environmentId: "e", title: "t", fileIds: ["f1"], vaultIds: ["v1"] }), { id: "s1" });
  assert.deepEqual(body(seen[0]), { agent_id: "a", environment_id: "e", title: "t", resources: [{ type: "file", file_id: "f1" }, { type: "vault", vault_id: "v1" }] });
  await api.sendMessage("s1", "go");
  assert.deepEqual(body(seen[1]), { events: [{ type: "user.message", data: { content: [{ type: "text", text: "go" }] } }] });
  assert.deepEqual(await api.listArtifacts("s1"), [{ id: "ar1", name: "out.md" }]);
  assert.match(seen[2].url, /\/artifacts\?session_id=s1&page_size=100$/);
  assert.deepEqual([...(await api.downloadArtifact("ar1"))], [1, 2, 3]);
  await api.archiveSession("s1");
  assert.equal(seen[4].url, "https://api.moonshot.cn/v1/sessions/s1/archive");
});

const sse = (text: string, chunk = text.length) => new Response(new ReadableStream({
  start(controller) {
    for (let i = 0; i < text.length; i += chunk) controller.enqueue(new TextEncoder().encode(text.slice(i, i + chunk)));
    controller.close();
  },
}));
const frame = (id: string, type: string, data: unknown) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ id: `e${id}`, type, data })}\n\n`;

test("events yields cursor, type and data per frame, and resumes with Last-Event-ID", async () => {
  const text = frame("7", "agent.message", { text: "hi" }) + frame("8", "session.status", { status: "idle" });
  const { api, seen } = setup(sse(text, 5), sse(""));
  const got = [];
  const controller = new AbortController();
  for await (const event of api.events("s1", { cursor: "6", signal: controller.signal })) got.push(event);
  assert.deepEqual(got, [{ cursor: "7", type: "agent.message", data: { text: "hi" } }, { cursor: "8", type: "session.status", data: { status: "idle" } }]);
  assert.equal(seen[0].headers.get("last-event-id"), "6");
  assert.equal(seen[0].headers.get("accept"), "text/event-stream");
  assert.equal(seen[0].signal, controller.signal);
  for await (const _ of api.events("s1", {})) assert.fail("no frames expected");
  assert.equal(seen[1].headers.get("last-event-id"), null);
});

test("the SSE parser handles multi-line data, CRLF, comments, split chunks and a cut-off last frame", async () => {
  const text = ": keepalive\r\nid: 1\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: solo\n\nid: 3\ndata: cut";
  const bytes = new TextEncoder().encode(text);
  async function* pieces() { for (let i = 0; i < bytes.length; i += 3) yield bytes.slice(i, i + 3); }
  const frames = [];
  for await (const f of sseFrames(pieces())) frames.push(f);
  assert.deepEqual(frames, [{ id: "1", event: "a", data: "one\ntwo" }, { id: undefined, event: undefined, data: "solo" }]);
});

test("errors carry status and the API message, retry once on 429/5xx, and never include the key", async () => {
  const bad = (status: number, message: string) => json({ error: { type: "x", message } }, status);
  const retried = setup(bad(429, "slow down"), json({ items: [] }));
  assert.equal(await retried.api.findAgent("x"), undefined);
  assert.equal(retried.seen.length, 2);

  const failing = setup(bad(503, "down"), bad(503, "still down"));
  await assert.rejects(failing.api.findAgent("x"), (error: unknown) => {
    assert.ok(error instanceof KimiApiError);
    assert.equal(error.status, 503);
    assert.match(error.message, /503.*still down/);
    assert.ok(!error.message.includes(KEY));
    return true;
  });
  assert.equal(failing.seen.length, 2);

  const rejected = setup(bad(400, "invalid name"));
  await assert.rejects(rejected.api.createAgent(agent, [], ""), /400.*invalid name/);
  assert.equal(rejected.seen.length, 1);

  const html = setup(new Response("<html>oops</html>", { status: 404, statusText: "Not Found" }));
  await assert.rejects(html.api.findAgent("x"), (error: Error) => error.message === "Kimi API 404: Not Found");
});
