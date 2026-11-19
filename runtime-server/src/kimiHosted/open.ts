import type { BuyerFiles } from "../agentBox/files.js";
import { PostgresProductCapabilities, type ProductCapabilities } from "../agentBox/capabilities.js";
import type { HtmlPages } from "../agentBox/htmlPages.js";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import { HttpKimiHostedApi, kimiHostedConfigFromEnvironment, type KimiHostedApi } from "./api.js";
import type { ReportPublisher } from "./engine.js";
import { PostgresKimiSessions, type KimiSessions } from "./sessions.js";

/** What the Kimi Hosted engine runs on: the switch, the platform's API (absent without its configuration), and the durable sessions. */
export type KimiHostedMode = { capabilities: ProductCapabilities; api?: KimiHostedApi; sessions: KimiSessions };

/** The report is saved as the buyer's file and published as a page: the very path publish_html takes. */
export class HtmlPagesPublisher implements ReportPublisher {
  constructor(private readonly files: BuyerFiles, private readonly pages: HtmlPages) {}
  async publish(owner: { productId: string; userId: string }, name: string, html: Buffer, title: string): Promise<string> {
    const scope = { kind: "buyer" as const, ...owner };
    const saved = await this.files.save(scope, name, html);
    return (await this.pages.publish(scope, saved.id, title)).url;
  }
}

/** The engine's switch and sessions in production. The API is undefined without KIMI_HOSTED_* set: a Product switched on then fails its Runs and says why. */
export async function openKimiHostedMode(options: { pool: PostgresQueryExecutor; environment: NodeJS.ProcessEnv }): Promise<KimiHostedMode> {
  const capabilities = new PostgresProductCapabilities(options.pool);
  const sessions = new PostgresKimiSessions(options.pool);
  await capabilities.initialize();
  await sessions.initialize();
  const config = kimiHostedConfigFromEnvironment(options.environment);
  return { capabilities, sessions, ...config ? { api: new HttpKimiHostedApi(config) } : {} };
}
