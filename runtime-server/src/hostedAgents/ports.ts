/**
 * A thick hosted agent: Hatch owns everything a run needs (system packages, skills, secrets,
 * browser profiles) and declares it here; the provider only executes it in a fresh sandbox.
 */

/** The sandbox image every run starts from. Changing it yields a new provider-side version. */
export type SandboxSpec = {
  name: string;
  packages: { apt?: string[]; pip?: string[]; npm?: string[] };
  /** Runs once per image build, after packages, as `bash -c` with `set -eo pipefail`. */
  setupScript: string;
  networking: { type: "unrestricted" } | { type: "limited"; allowedHosts: string[] };
};

/** A skill is a local directory with SKILL.md at its root, uploaded as a package. */
export type SkillSpec = { name: string; dir: string };

export type AgentSpec = { name: string; model: string; system: string; skills: SkillSpec[] };

/**
 * A secret reaches the sandbox only as a placeholder in an environment variable; the provider
 * swaps in the real value on outbound requests to `hosts`. The sandbox never sees the value.
 */
export type HostedSecret = { name: string; value: string; hosts: string[] };

export type HostedFile = { name: string; bytes: Buffer; mimeType?: string };

export type HostedTask = {
  title: string;
  prompt: string;
  files: HostedFile[];
  secrets: HostedSecret[];
};

export type HostedArtifact = { name: string; bytes: Buffer };

export type HostedResult = {
  sessionId: string;
  status: "done" | "failed";
  /** The agent's final message of the run. */
  text: string;
  artifacts: HostedArtifact[];
  error?: string;
};

export interface HostedAgentProvider {
  run(task: HostedTask, signal?: AbortSignal): Promise<HostedResult>;
}

/** A provider-side resource we own, found by name. */
export type Owned = { id: string; name: string; description?: string };

/** The Kimi Hosted Agents REST surface (https://api.moonshot.cn/v1, `kimi-api-version: 2026-09-01-beta`). */
export interface KimiHostedApi {
  findEnvironment(name: string): Promise<(Owned & { buildStatus: "building" | "ready" | "failed" }) | undefined>;
  createEnvironment(spec: SandboxSpec, description: string): Promise<Owned>;
  updateEnvironment(id: string, spec: SandboxSpec, description: string): Promise<Owned>;
  environmentStatus(id: string): Promise<{ buildStatus: "building" | "ready" | "failed"; error?: string }>;

  /** Uploads a skill package (zip of the directory) and returns the id and version to bind. */
  uploadSkill(name: string, zip: Buffer): Promise<{ id: string; version: string }>;
  findAgent(name: string): Promise<Owned | undefined>;
  createAgent(spec: AgentSpec, skills: Array<{ id: string; version: string }>, description: string): Promise<Owned>;
  updateAgent(id: string, spec: AgentSpec, skills: Array<{ id: string; version: string }>, description: string): Promise<Owned>;

  createVault(displayName: string): Promise<{ id: string }>;
  addSecret(vaultId: string, secret: HostedSecret): Promise<void>;
  deleteVault(vaultId: string): Promise<void>;

  uploadFile(file: HostedFile): Promise<{ id: string }>;
  deleteFile(fileId: string): Promise<void>;

  createSession(input: { agentId: string; environmentId: string; title: string; fileIds: string[]; vaultIds: string[] }): Promise<{ id: string }>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  /** Server-sent events of a session, resuming from `cursor` after a dropped connection. */
  events(sessionId: string, options: { cursor?: string; signal?: AbortSignal }): AsyncIterable<{ cursor: string; type: string; data: Record<string, unknown> }>;
  listArtifacts(sessionId: string): Promise<Array<{ id: string; name: string }>>;
  downloadArtifact(id: string): Promise<Buffer>;
  archiveSession(sessionId: string): Promise<void>;
}

/** One cookie as a browser stores it. The value is the secret part. */
export type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

/** What makes a logged-in browser look like the same person every time: cookies, fingerprint, exit IP. */
export type BrowserProfile = {
  id: string;
  accountId: string;
  /** e.g. "xiaohongshu", "douyin". */
  platform: string;
  label: string;
  /** Hosts the cookies may be sent to; the provider injects them only there. */
  hosts: string[];
  cookies: BrowserCookie[];
  fingerprint: { userAgent: string; locale: string; timezone: string; viewport: { width: number; height: number } };
  /** Proxy URL for a fixed exit IP, e.g. http://user:pass@host:port. */
  proxy?: string;
  status: "ready" | "needs_login";
  note?: string;
  updatedAt: string;
  lastUsedAt?: string;
};

export type ProfileLease = { profile: BrowserProfile; leaseId: string; expiresAt: string };

export interface BrowserProfileStore {
  put(profile: Omit<BrowserProfile, "id" | "updatedAt"> & { id?: string }): Promise<BrowserProfile>;
  list(accountId: string): Promise<BrowserProfile[]>;
  /** Leases each ready, unleased profile of these platforms; one holder per profile at a time. */
  lease(accountId: string, platforms: string[], holder: string, ttlMs: number): Promise<ProfileLease[]>;
  /** Ends a lease, writing back cookies the run refreshed and the outcome. */
  release(leaseId: string, outcome: { cookies?: BrowserCookie[]; status: BrowserProfile["status"]; note?: string }): Promise<void>;
  remove(accountId: string, id: string): Promise<void>;
}
