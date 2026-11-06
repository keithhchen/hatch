import { asJson, findFirst, KimiApiError, paginate, sender, withBase, withErrors, withHeaders, withRetry, type Fetch, type Send } from "./http.js";
import { sseFrames } from "./sse.js";
import type { AgentSpec, HostedFile, HostedSecret, KimiHostedApi, Owned, SandboxSpec } from "./ports.js";

export { zipDirectory } from "./zip.js";

type BuildStatus = "building" | "ready" | "failed";
type Resource = Owned & { scope?: string; build_status?: BuildStatus };
type SkillRef = { id: string; version: string };

const API_VERSION = "2026-09-01-beta";
const TOOLSET = { type: "agent_toolset", name: "default_toolset_20260901" };
const PAGE_SIZE = 100;

const owned = ({ id, name, description }: Resource): Owned => ({ id, name, description });
/** Official resources share the lists; only ours are matched by name. */
const mine = (name: string) => (item: Resource) => item.name === name && item.scope !== "official";

const environmentBody = (spec: SandboxSpec, description: string) => ({
  name: spec.name,
  description,
  config: {
    type: "cloud",
    networking: spec.networking.type === "limited" ? { type: "limited", allowed_hosts: spec.networking.allowedHosts } : { type: "unrestricted" },
    packages: { apt: spec.packages.apt ?? [], pip: spec.packages.pip ?? [], npm: spec.packages.npm ?? [] },
    setup_script: spec.setupScript,
  },
});

const agentBody = (spec: AgentSpec, skills: SkillRef[], description: string) => ({
  name: spec.name,
  description,
  model: { id: spec.model },
  system: spec.system,
  tools: [TOOLSET],
  skills: skills.map(skill => ({ skill_id: skill.id, version: skill.version })),
});

/** Kimi Hosted Agents over REST. Each method is one request (or one paginated walk) on the shared `json` / `send` core. */
export class KimiApi implements KimiHostedApi {
  private readonly send: Send;
  private readonly json: ReturnType<typeof asJson>;

  constructor(config: { apiKey: string; baseUrl?: string; fetch?: Fetch; retryDelayMs?: number }) {
    const base = withBase(config.fetch ?? fetch, config.baseUrl ?? "https://api.moonshot.cn/v1");
    const headers = withHeaders(base, { authorization: `Bearer ${config.apiKey}`, "kimi-api-version": API_VERSION });
    this.send = sender(withErrors(withRetry(headers, config.retryDelayMs ?? 500)));
    this.json = asJson(this.send);
  }

  private list<T>(path: string, query: Record<string, string | undefined> = {}) {
    return (pageToken?: string) => this.json<{ items: T[]; next_page_token?: string }>("GET", path, { query: { ...query, page_size: PAGE_SIZE, page_token: pageToken } });
  }

  async findEnvironment(name: string) {
    const found = await findFirst(this.list<Resource>("/environments"), mine(name));
    return found && { ...owned(found), buildStatus: found.build_status ?? "building" };
  }
  async createEnvironment(spec: SandboxSpec, description: string) { return owned(await this.json<Resource>("POST", "/environments", { json: environmentBody(spec, description) })); }
  async updateEnvironment(id: string, spec: SandboxSpec, description: string) { return owned(await this.json<Resource>("PATCH", `/environments/${id}`, { json: environmentBody(spec, description) })); }
  async environmentStatus(id: string) {
    const { build_status } = await this.json<Resource>("GET", `/environments/${id}`);
    return { buildStatus: build_status ?? "building", ...(build_status === "failed" ? { error: "environment build failed" } : {}) };
  }

  /** Skill names are unique and versions are immutable, so a revision archives the old skill and uploads a new one. */
  async uploadSkill(name: string, zip: Buffer) {
    const upload = () => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), `${name}.zip`);
      return this.json<{ skill: { id: string }; version: { version: string } }>("POST", "/skills", { form });
    };
    const created = await upload().catch(async error => {
      if (!(error instanceof KimiApiError) || error.status !== 409) throw error;
      const old = await findFirst(this.list<Resource>("/skills"), mine(name));
      if (old) await this.send("POST", `/skills/${old.id}/archive`);
      return upload();
    });
    return { id: created.skill.id, version: created.version.version };
  }

  async findAgent(name: string) {
    const found = await findFirst(this.list<Resource>("/agents"), mine(name));
    return found && owned(found);
  }
  async createAgent(spec: AgentSpec, skills: SkillRef[], description: string) { return owned(await this.json<Resource>("POST", "/agents", { json: agentBody(spec, skills, description) })); }
  async updateAgent(id: string, spec: AgentSpec, skills: SkillRef[], description: string) { return owned(await this.json<Resource>("PATCH", `/agents/${id}`, { json: agentBody(spec, skills, description) })); }

  createVault(displayName: string) { return this.json<{ id: string }>("POST", "/vaults", { json: { display_name: displayName } }).then(({ id }) => ({ id })); }
  async addSecret(vaultId: string, secret: HostedSecret) {
    await this.send("POST", `/vaults/${vaultId}/credentials`, {
      json: { display_name: secret.name, auth: { type: "environment_variable", secret_name: secret.name, secret_value: secret.value, networking: { type: "limited", allowed_hosts: secret.hosts } } },
    });
  }
  /** A vault must be archived before it can be deleted. */
  async deleteVault(vaultId: string) {
    await this.send("POST", `/vaults/${vaultId}/archive`);
    await this.send("DELETE", `/vaults/${vaultId}`);
  }

  uploadFile(file: HostedFile) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.mimeType ?? "application/octet-stream" }), file.name);
    return this.json<{ id: string }>("POST", "/files", { form }).then(({ id }) => ({ id }));
  }
  async deleteFile(fileId: string) { await this.send("DELETE", `/files/${fileId}`); }

  createSession(input: { agentId: string; environmentId: string; title: string; fileIds: string[]; vaultIds: string[] }) {
    const resources = [...input.fileIds.map(file_id => ({ type: "file", file_id })), ...input.vaultIds.map(vault_id => ({ type: "vault", vault_id }))];
    return this.json<{ id: string }>("POST", "/sessions", { json: { agent_id: input.agentId, environment_id: input.environmentId, title: input.title, resources } }).then(({ id }) => ({ id }));
  }
  async sendMessage(sessionId: string, text: string) {
    await this.send("POST", `/sessions/${sessionId}/events`, { json: { events: [{ type: "user.message", data: { content: [{ type: "text", text }] } }] } });
  }
  /** Yields every frame of one connection; reconnecting from the last cursor is the caller's job. */
  async *events(sessionId: string, { cursor, signal }: { cursor?: string; signal?: AbortSignal }) {
    const response = await this.send("GET", `/sessions/${sessionId}/events/stream`, { signal, headers: { accept: "text/event-stream", ...(cursor ? { "last-event-id": cursor } : {}) } });
    for await (const frame of sseFrames(response.body as unknown as AsyncIterable<Uint8Array>)) {
      const event = JSON.parse(frame.data) as { id?: string; type?: string; data?: Record<string, unknown> };
      yield { cursor: frame.id ?? event.id ?? "", type: event.type ?? frame.event ?? "", data: event.data ?? {} };
    }
  }

  async listArtifacts(sessionId: string) {
    const found: Array<{ id: string; name: string }> = [];
    for await (const { id, name } of paginate(this.list<Owned>("/artifacts", { session_id: sessionId }))) found.push({ id, name });
    return found;
  }
  async downloadArtifact(id: string) { return Buffer.from(await (await this.send("GET", `/artifacts/${id}/content`)).arrayBuffer()); }
  async archiveSession(sessionId: string) { await this.send("POST", `/sessions/${sessionId}/archive`); }
}
