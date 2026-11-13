import type { Pool } from "pg";
import type { CredentialSeal } from "../assistant/channelCredentials.js";
import type { ArtifactObjectStore } from "../creatorLearning/objectStore.js";
import type { StagedUploads } from "./ports.js";
import { HostedIngest } from "../hostedAgents/ingest.js";
import { INGEST_SANDBOX, ingestAgent, ingestSecrets } from "../hostedAgents/ingestAgent.js";
import { PostgresBrowserProfiles } from "../hostedAgents/browserProfiles.js";
import { KimiApi } from "../hostedAgents/kimiApi.js";
import { KimiHostedAgent, TracedHostedAgent } from "../hostedAgents/kimiHostedAgent.js";
import type { BrowserProfileStore } from "../hostedAgents/ports.js";
import { Provisioner } from "../hostedAgents/provisioner.js";
import { zipDirectory } from "../hostedAgents/zip.js";
import { HostedEngine, PlainTextEngine, RoutingEngine, UnavailableEngine } from "./engines.js";
import { PostgresIngestJobs } from "./jobs.js";
import { ProductWorkspaceSink, type ManualFiles } from "./sink.js";
import { IngestService, STALE_MS } from "./service.js";
import { log } from "../observability/log.js";
import type { ModelRoleResolver } from "../modelRoles.js";
import type { UsageCap } from "../usage/usageCap.js";

/** A deployment without a profile seal has no stored logins: links run anonymously. */
export class NoBrowserProfiles implements BrowserProfileStore {
  async put(): Promise<never> { throw new Error("Browser profiles require HATCH_CREDENTIALS_KEY"); }
  async list() { return []; }
  async lease() { return []; }
  async release() {}
  async remove() {}
}

export const HOSTED_NOT_CONFIGURED = "Hosted ingest is not configured";

/** The hosted engine when a Kimi key is set; otherwise an engine that says why it cannot run. */
export const hostedEngineFromEnvironment = async (environment: NodeJS.ProcessEnv, pool: Pool, models: ModelRoleResolver, staged: StagedUploads, seal?: CredentialSeal) => {
  const apiKey = environment.HATCH_MANAGED_AGENTS_API_KEY?.trim();
  if (!apiKey) return new UnavailableEngine(HOSTED_NOT_CONFIGURED);
  const api = new KimiApi({ apiKey });
  // The agent's model is the `ingest` role's, read for each job: a changed row reprovisions the hosted agent on its next run.
  const model = async () => (await models.resolve("ingest")).model;
  const agent = new TracedHostedAgent(new KimiHostedAgent(api, new Provisioner(api, INGEST_SANDBOX, async () => ingestAgent(await model()), zipDirectory)), "kimi_hosted_agents", model);
  const profiles = seal ? await PostgresBrowserProfiles.open(pool, seal) : new NoBrowserProfiles();
  return new HostedEngine(new HostedIngest(agent, profiles, ingestSecrets(environment)), staged);
};

/** A hosted run takes a while: the download link outlives a typical run. */
const DOWNLOAD_SECONDS = 60 * 60;

export const stagedUploads = (objects: ArtifactObjectStore): StagedUploads => ({
  read: key => objects.get(key),
  downloadUrl: async key => (await objects.presign(key, { method: "GET", expiresSeconds: DOWNLOAD_SECONDS })).url,
});

/** Registry's ingest: jobs in Postgres, plain text stored directly, the rest on the hosted agent. */
export const createIngestService = async (deps: {
  environment: NodeJS.ProcessEnv;
  pool: Pool;
  models: ModelRoleResolver;
  seal?: CredentialSeal;
  objects: ArtifactObjectStore;
  /** The Product's shared manual files. */
  manual: (accountId: string, productId: string) => Promise<ManualFiles>;
  /** `<prefix>/<account>/<product>`: where the Product's objects live. */
  productPrefix: (accountId: string, productId: string) => string;
  /** Whether the account owns the Product. */
  owns: (accountId: string, productId: string) => Promise<boolean>;
  usageCap?: UsageCap;
}): Promise<IngestService> => {
  const staged = stagedUploads(deps.objects);
  const service = new IngestService({
    owns: deps.owns,
    usageCap: deps.usageCap,
    jobs: await PostgresIngestJobs.open(deps.pool),
    objects: deps.objects,
    engine: new RoutingEngine([new PlainTextEngine(staged), await hostedEngineFromEnvironment(deps.environment, deps.pool, deps.models, staged, deps.seal)]),
    sink: new ProductWorkspaceSink(deps.manual, deps.objects, deps.productPrefix),
  });
  await service.recoverInterrupted();
  // A job another process was running when this one booted is only recovered once it falls silent.
  setInterval(() => void service.recoverInterrupted().catch(error => log.error("ingest_recover_failed", { error })), STALE_MS).unref();
  return service;
};
