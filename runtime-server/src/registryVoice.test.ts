import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RegistryStoreTs } from "./registryStore.js";
import { createRegistryServerFromEnvironment } from "./registryServer.js";
import type { VoiceProvider } from "./voice.js";

class FakeVoiceProvider implements VoiceProvider {
  created: string[] = [];
  deleted: string[] = [];
  synthesized: Array<{ providerVoiceId: string; text: string; previousRequestIds: string[] }> = [];

  async createVoice(input: { name: string; files: Uint8Array[] }): Promise<string> {
    this.created.push(input.name);
    return `provider-voice-${this.created.length}`;
  }

  async synthesize(input: { providerVoiceId: string; text: string; previousRequestIds: string[] }): Promise<{ audio: Uint8Array; requestId: string }> {
    this.synthesized.push(input);
    return { audio: new Uint8Array([0x01, 0x02, 0x03]), requestId: `req_${input.text.length}` };
  }

  async deleteVoice(providerVoiceId: string): Promise<void> {
    this.deleted.push(providerVoiceId);
  }
}

function sample(): Uint8Array {
  return new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
}

test("Registry voice asset upserts, replaces, revokes, and persists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-voice-store-"));
  const statePath = path.join(root, "registry.json");
  const provider = new FakeVoiceProvider();
  const store = await RegistryStoreTs.open({
    corpusRoot: path.join(root, "corpora"),
    statePath,
    voiceProvider: provider,
    environment: {}
  });

  const first = await store.upsertVoice({ creatorId: "maya-chen", creatorName: "Maya Chen", sample: sample(), sampleFormat: "mp3", consentVersion: "v1" });
  assert.equal(first.status, "active");
  assert.equal(first.provider, "elevenlabs");
  assert.match(first.sample.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(provider.created.length, 1);
  assert.deepEqual(store.voiceStatus("maya-chen"), { enabled: true, label: "maya-chen 的声音" });

  const second = await store.upsertVoice({ creatorId: "maya-chen", creatorName: "Maya Chen", sample: sample(), sampleFormat: "mp3", consentVersion: "v1" });
  assert.equal(provider.created.length, 2);
  assert.equal(provider.deleted.length, 1);
  assert.equal(provider.deleted[0], first.provider_voice_id);
  assert.notEqual(second.provider_voice_id, first.provider_voice_id);

  const restored = await RegistryStoreTs.open({
    corpusRoot: path.join(root, "corpora"),
    statePath,
    voiceProvider: provider,
    environment: {}
  });
  assert.equal(restored.getVoice("maya-chen")?.provider_voice_id, second.provider_voice_id);

  const revoked = await store.revokeVoice("maya-chen");
  assert.equal(revoked?.status, "revoked");
  assert.ok(revoked?.revoked_at);
  assert.equal(provider.deleted[1], second.provider_voice_id);
  assert.equal(store.voiceStatus("maya-chen"), null);
});

test("Registry TTS synthesis enforces an active voice and records usage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-voice-tts-"));
  const provider = new FakeVoiceProvider();
  const store = await RegistryStoreTs.open({
    corpusRoot: path.join(root, "corpora"),
    statePath: path.join(root, "registry.json"),
    voiceProvider: provider,
    environment: {}
  });

  await assert.rejects(
    store.synthesizeVoice({ creatorId: "maya-chen", agentId: "resume-review", text: "hello", previousRequestIds: [] }),
    /voice_not_configured/
  );

  await store.upsertVoice({ creatorId: "maya-chen", creatorName: "Maya Chen", sample: sample(), sampleFormat: "mp3", consentVersion: "v1" });
  const result = await store.synthesizeVoice({
    creatorId: "maya-chen",
    agentId: "resume-review",
    text: "你好",
    previousRequestIds: ["req_1", "req_2"]
  });
  assert.equal(result.requestId, "req_2");
  assert.equal(provider.synthesized.length, 1);
  assert.deepEqual(provider.synthesized[0]?.previousRequestIds, ["req_1", "req_2"]);

  await store.revokeVoice("maya-chen");
  await assert.rejects(
    store.synthesizeVoice({ creatorId: "maya-chen", agentId: "resume-review", text: "hello", previousRequestIds: [] }),
    /voice_not_configured/
  );
});

test("TypeScript Registry voice routes manage creator voice and TTS", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-voice-"));
  const provider = new FakeVoiceProvider();
  const registry = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1",
    REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"),
    HATCH_REGISTRY_STATE_PATH: path.join(root, "state.json"),
    HATCH_AUTH_SIGNING_SECRET: "test-secret",
    HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN: "publish-token",
    HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN: "runtime-token",
    HATCH_QDRANT_URL: "",
    DASHSCOPE_API_KEY: ""
  }, provider);
  try {
    const address = registry.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;

    const signup = await fetch(`${base}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "maya@example.com", password: "password-123", role: "creator", display_name: "Maya Chen" }) });
    const account = await signup.json();
    const creatorAuth = { authorization: `Bearer ${account.token}`, "content-type": "application/json" };

    const missing = await fetch(`${base}/v1/creators/${account.account.id}/voice`, { headers: { authorization: `Bearer ${account.token}` } });
    assert.equal(missing.status, 404);

    const boundary = `----voice${Date.now()}`;
    const form = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`, "utf8"),
      Buffer.from(`Content-Disposition: form-data; name="files"; filename="voice.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`, "utf8"),
      Buffer.from(sample()),
      Buffer.from(`\r\n--${boundary}\r\n`, "utf8"),
      Buffer.from(`Content-Disposition: form-data; name="consent_version"\r\n\r\nv1\r\n`, "utf8"),
      Buffer.from(`--${boundary}--\r\n`, "utf8")
    ]);
    const created = await fetch(`${base}/v1/creators/${account.account.id}/voice`, {
      method: "PUT",
      headers: { authorization: `Bearer ${account.token}`, "content-type": `multipart/form-data; boundary=${boundary}` },
      body: form
    });
    assert.equal(created.status, 201);
    const asset = await created.json();
    assert.equal(asset.status, "active");
    assert.equal(provider.created.length, 1);

    const fetched = await fetch(`${base}/v1/creators/${account.account.id}/voice`, { headers: { authorization: `Bearer ${account.token}` } });
    assert.equal(fetched.status, 200);
    assert.equal((await fetched.json()).voice_id, asset.voice_id);

    const otherCreator = await fetch(`${base}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "jordan@example.com", password: "password-123", role: "creator", display_name: "Jordan" }) });
    const other = await otherCreator.json();
    const forbidden = await fetch(`${base}/v1/creators/${account.account.id}/voice`, { headers: { authorization: `Bearer ${other.token}` } });
    assert.equal(forbidden.status, 403);

    const tts = await fetch(`${base}/v1/tts`, {
      method: "POST",
      headers: { authorization: "Bearer runtime-token", "content-type": "application/json" },
      body: JSON.stringify({ creator_id: "maya-chen", agent_id: "resume-review", text: "朗读这段", previous_request_ids: ["req_1"] })
    });
    assert.equal(tts.status, 200);
    assert.equal(tts.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual([...new Uint8Array(await tts.arrayBuffer())], [1, 2, 3]);
    assert.equal(provider.synthesized.length, 1);
    assert.equal(provider.synthesized[0]?.text, "朗读这段");
    assert.deepEqual(provider.synthesized[0]?.previousRequestIds, ["req_1"]);

    const unauthorized = await fetch(`${base}/v1/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ creator_id: "maya-chen", agent_id: "resume-review", text: "x" })
    });
    assert.equal(unauthorized.status, 403);

    const deleted = await fetch(`${base}/v1/creators/${account.account.id}/voice`, { method: "DELETE", headers: { authorization: `Bearer ${account.token}` } });
    assert.equal(deleted.status, 204);
    const afterRevoke = await fetch(`${base}/v1/tts`, {
      method: "POST",
      headers: { authorization: "Bearer runtime-token", "content-type": "application/json" },
      body: JSON.stringify({ creator_id: "maya-chen", agent_id: "resume-review", text: "x" })
    });
    assert.equal(afterRevoke.status, 403);
  } finally {
    await registry.close();
  }
});

test("Registry catalog carries creator voice status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-catalog-voice-"));
  const provider = new FakeVoiceProvider();
  const store = await RegistryStoreTs.open({
    corpusRoot: path.join(root, "corpora"),
    statePath: path.join(root, "state.json"),
    voiceProvider: provider,
    environment: {}
  });
  const silent = await store.voiceStatus("no-voice-creator");
  assert.equal(silent, null);
  assert.equal(createHash("sha256").update(Buffer.from(sample())).digest("hex").length, 64);
});
