import type { Pool } from "pg";
import type { CredentialSeal } from "../assistant/channelCredentials.js";
import type { ArtifactObjectStore } from "../creatorLearning/objectStore.js";
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
import { IngestService } from "./service.js";

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
export const hostedEngineFromEnvironment = async (environment: NodeJS.ProcessEnv, pool: Pool, seal?: CredentialSeal) => {
  const apiKey = environment.HATCH_MANAGED_AGENTS_API_KEY?.trim();
  if (!apiKey) return new UnavailableEngine(HOSTED_NOT_CONFIGURED);
  const api = new KimiApi({ apiKey });
  const model = environment.HATCH_INGEST_MODEL?.trim() || "kimi-k3.1-pro";
  const agent = new TracedHostedAgent(new KimiHostedAgent(api, new Provisioner(api, INGEST_SANDBOX, ingestAgent(model), zipDirectory)), "kimi_hosted_agents", model);
  const profiles = seal ? await PostgresBrowserProfiles.open(pool, seal) : new NoBrowserProfiles();
  return new HostedEngine(new HostedIngest(agent, profiles, ingestSecrets(environment)));
};

/** Registry's ingest: jobs in Postgres, plain text stored directly, the rest on the hosted agent. */
export const createIngestService = async (deps: {
  environment: NodeJS.ProcessEnv;
  pool: Pool;
  seal?: CredentialSeal;
  objects: ArtifactObjectStore;
  /** The Product's shared manual files. */
  manual: (accountId: string, productId: string) => Promise<ManualFiles>;
  /** `<prefix>/<account>/<product>`: where the Product's objects live. */
  productPrefix: (accountId: string, productId: string) => string;
}): Promise<IngestService> => {
  const service = new IngestService({
    jobs: await PostgresIngestJobs.open(deps.pool),
    engine: new RoutingEngine([new PlainTextEngine(), await hostedEngineFromEnvironment(deps.environment, deps.pool, deps.seal)]),
    sink: new ProductWorkspaceSink(deps.manual, deps.objects, deps.productPrefix),
  });
  await service.recoverInterrupted();
  return service;
};
