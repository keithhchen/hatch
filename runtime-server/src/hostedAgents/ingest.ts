import { createHash } from "node:crypto";
import type { BrowserProfile, BrowserProfileStore, HostedAgentProvider, HostedArtifact, HostedFile, HostedSecret, ProfileLease } from "./ports.js";

export type IngestItem =
  | { id: string; kind: "link"; url: string }
  | { id: string; kind: "file"; name: string; bytes: Buffer; mimeType?: string };

export type IngestedItem = {
  id: string;
  status: "ok" | "partial" | "failed";
  original?: HostedArtifact;
  markdown?: string;
  error?: string;
};

export type IngestRequest = { accountId: string; items: IngestItem[]; context: string };
export type IngestOutcome = { sessionId: string; items: IngestedItem[]; report: string };

type SkillResult = {
  items: Array<{ id: string; status: IngestedItem["status"]; original?: string; markdown?: string; error?: string }>;
  profiles: Array<{ id: string; status: BrowserProfile["status"]; note?: string }>;
};

const hostMatches = (pattern: string, host: string) =>
  pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern;

/** Profiles a batch needs: those whose hosts cover any link in it. */
export const platformsFor = (items: IngestItem[], profiles: BrowserProfile[]) => {
  const hosts = items.flatMap(item => item.kind === "link" ? [new URL(item.url).hostname] : []);
  return [...new Set(profiles.filter(p => hosts.some(h => p.hosts.some(pattern => hostMatches(pattern, h)))).map(p => p.platform))];
};

const short = (id: string) => id.replace(/-/g, "").slice(0, 8).toUpperCase();
const json = (name: string, value: unknown): HostedFile => ({ name, bytes: Buffer.from(JSON.stringify(value, null, 2)), mimeType: "application/json" });

/**
 * A leased profile, as the sandbox sees it: every secret value becomes a vault placeholder
 * reachable through an environment variable, injected only on requests to the profile's hosts.
 */
export const exposeProfile = ({ profile }: ProfileLease) => {
  const tag = short(profile.id);
  const cookieSecrets: HostedSecret[] = profile.cookies.map((c, i) => ({ name: `HATCH_CK_${tag}_${i}`, value: c.value, hosts: profile.hosts }));
  const proxySecret: HostedSecret[] = profile.proxy ? [{ name: `HATCH_PX_${tag}`, value: profile.proxy, hosts: [new URL(profile.proxy).hostname] }] : [];
  return {
    secrets: [...cookieSecrets, ...proxySecret],
    manifest: {
      id: profile.id, platform: profile.platform, hosts: profile.hosts, fingerprint: profile.fingerprint,
      cookies: profile.cookies.map(({ value: _value, ...cookie }, i) => ({ ...cookie, value_env: cookieSecrets[i]!.name })),
      proxy_env: proxySecret[0]?.name ?? null,
    },
  };
};

const PROMPT = (context: string) => [
  "Use the hatch-ingest skill. The task manifest is task.json and the browser profiles are browser-profiles.json, both under /mnt/agents/upload/.",
  "Ingest every item, save every file the skill writes to /mnt/agents/output/ with save_artifact, then report in one paragraph.",
  context ? `Context: ${context}` : "",
].filter(Boolean).join("\n");

/**
 * Ingests links and files into (original, Markdown) pairs on a thick hosted agent.
 * Owns the browser-profile lifecycle around the run: lease, expose as placeholders, write back, release.
 */
export class HostedIngest {
  constructor(
    private readonly agent: HostedAgentProvider,
    private readonly profiles: BrowserProfileStore,
    private readonly platformSecrets: HostedSecret[] = [],
    private readonly leaseMs = 60 * 60_000,
  ) {}

  async ingest(request: IngestRequest, signal?: AbortSignal): Promise<IngestOutcome> {
    const platforms = platformsFor(request.items, await this.profiles.list(request.accountId));
    const leases = platforms.length ? await this.profiles.lease(request.accountId, platforms, `ingest:${Date.now()}`, this.leaseMs) : [];
    const exposed = leases.map(exposeProfile);
    let result: SkillResult | undefined;
    try {
      const run = await this.agent.run({
        title: `ingest ${request.items.length} item(s)`,
        prompt: PROMPT(request.context),
        secrets: [...this.platformSecrets, ...exposed.flatMap(e => e.secrets)],
        files: [
          // Files are found by content: the provider may rename uploads on mount, but never their bytes.
          json("task.json", { context: request.context, items: request.items.map(item => item.kind === "link" ? item : { id: item.id, kind: "file", name: item.name, sha256: createHash("sha256").update(item.bytes).digest("hex") }) }),
          json("browser-profiles.json", { profiles: exposed.map(e => e.manifest) }),
          ...request.items.flatMap(item => item.kind === "file" ? [{ name: item.name, bytes: item.bytes, mimeType: item.mimeType }] : []),
        ],
      }, signal);
      const byName = new Map(run.artifacts.map(a => [a.name, a]));
      const manifest = byName.get("result.json");
      if (!manifest) throw new Error(run.error ?? "The hosted agent finished without result.json");
      result = JSON.parse(manifest.bytes.toString("utf8")) as SkillResult;
      await this.writeBack(leases, result, byName);
      return {
        sessionId: run.sessionId,
        report: run.text,
        items: request.items.map(({ id }) => {
          const item = result!.items.find(i => i.id === id);
          if (!item) return { id, status: "failed", error: "The hosted agent did not report this item" };
          return {
            id, status: item.status,
            ...(item.original && byName.has(item.original) ? { original: byName.get(item.original)! } : {}),
            ...(item.markdown && byName.has(item.markdown) ? { markdown: byName.get(item.markdown)!.bytes.toString("utf8") } : {}),
            ...(item.error ? { error: item.error } : {}),
          };
        }),
      };
    } finally {
      // A run that never produced a verdict hands its profiles back untouched.
      if (!result) await Promise.all(leases.map(lease => this.profiles.release(lease.leaseId, { status: "ready" })));
    }
  }

  private async writeBack(leases: ProfileLease[], result: SkillResult, artifacts: Map<string, HostedArtifact>) {
    await Promise.all(leases.map(async lease => {
      const verdict = result.profiles.find(p => p.id === lease.profile.id);
      const refreshed = artifacts.get(`profile.${lease.profile.id}.json`);
      await this.profiles.release(lease.leaseId, {
        status: verdict?.status ?? "ready",
        ...(verdict?.note ? { note: verdict.note } : {}),
        ...(refreshed ? { cookies: JSON.parse(refreshed.bytes.toString("utf8")).cookies ?? [] } : {}),
      });
    }));
  }
}
