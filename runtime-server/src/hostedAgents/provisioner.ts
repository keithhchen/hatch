import { createHash } from "node:crypto";
import type { AgentSpec, KimiHostedApi, Owned, SandboxSpec } from "./ports.js";

/** Canonical digest of a declaration: the provider-side resource is current when its description carries it. */
export function specDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])]))
    : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex").slice(0, 16);
}

type Reconcilable<S> = {
  find(name: string): Promise<Owned | undefined>;
  create(spec: S, description: string): Promise<Owned>;
  update(id: string, spec: S, description: string): Promise<Owned>;
};

/** Makes the provider match a declaration: create when missing, update when the digest moved, else reuse. */
export const reconcile = <S extends { name: string }>(resource: Reconcilable<S>) =>
  async (spec: S, digest: string): Promise<Owned> => {
    const description = `hatch:${digest}`;
    const existing = await resource.find(spec.name);
    if (!existing) return resource.create(spec, description);
    return existing.description === description ? existing : resource.update(existing.id, spec, description);
  };

const memo = <T>(make: () => Promise<T>) => { let value: Promise<T> | undefined; return () => (value ??= make()); };

/** Polls until `check` settles, with a deadline. */
export const until = <T>(check: () => Promise<T | undefined>, { everyMs = 3000, timeoutMs = 10 * 60_000 } = {}) =>
  async (signal?: AbortSignal): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const value = await check();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error("Timed out waiting for the hosted sandbox to build");
      await new Promise(resolve => setTimeout(resolve, everyMs));
    }
  };

export type Provisioned = { environmentId: string; agentId: string };

/**
 * Keeps one environment and one agent on the provider in step with Hatch's declarations.
 * Provisioning is memoized per declaration, so every run after the first costs two lookups at most.
 */
export class Provisioner {
  private current?: { digest: string; value: Promise<Provisioned> };
  constructor(
    private readonly api: KimiHostedApi,
    private readonly sandbox: SandboxSpec,
    private readonly agent: AgentSpec,
    private readonly pack: (dir: string) => Promise<Buffer>,
  ) {}

  ensure(signal?: AbortSignal): Promise<Provisioned> {
    const digest = specDigest({ sandbox: this.sandbox, agent: this.agent });
    if (this.current?.digest !== digest) {
      const value = this.provision(signal);
      value.catch(() => { if (this.current?.value === value) this.current = undefined; });
      this.current = { digest, value };
    }
    return this.current.value;
  }

  private async provision(signal?: AbortSignal): Promise<Provisioned> {
    const api = this.api;
    const environment = await reconcile<SandboxSpec>({
      find: name => api.findEnvironment(name),
      create: (spec, description) => api.createEnvironment(spec, description),
      update: (id, spec, description) => api.updateEnvironment(id, spec, description),
    })(this.sandbox, specDigest(this.sandbox));
    // Skill code is part of the agent: its bytes join the digest, and packages upload only when the agent must change.
    const packages = await Promise.all(this.agent.skills.map(async skill => ({ name: skill.name, zip: await this.pack(skill.dir) })));
    const uploaded = memo(() => Promise.all(packages.map(p => api.uploadSkill(p.name, p.zip))));
    const agent = await reconcile<AgentSpec>({
      find: name => api.findAgent(name),
      create: async (spec, description) => api.createAgent(spec, await uploaded(), description),
      update: async (id, spec, description) => api.updateAgent(id, spec, await uploaded(), description),
    })(this.agent, specDigest({ agent: this.agent, skills: packages.map(p => createHash("sha256").update(p.zip).digest("hex")) }));
    await until(async () => {
      const status = await api.environmentStatus(environment.id);
      if (status.buildStatus === "failed") throw new Error(`Hosted sandbox build failed${status.error ? `: ${status.error}` : ""}`);
      return status.buildStatus === "ready" ? true : undefined;
    })(signal);
    return { environmentId: environment.id, agentId: agent.id };
  }
}
