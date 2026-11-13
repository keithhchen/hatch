import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createFactoryHandler } from "./server.js";
import type { UsageRecorder } from "../usage/usage.js";
import type { UsageCap } from "../usage/usageCap.js";
import type { AgentDefinitionRepository } from "./definitions.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Journal } from "./journal.js";
import type { Session } from "./store.js";
import type { ModelRoleResolver } from "../modelRoles.js";

export type FactoryWorkspace = Awaited<ReturnType<typeof createFactoryHandler>>;

export class FactoryAgentsService {
  private products = new Map<string, ReturnType<typeof createFactoryHandler>>();
  private withheldTools?: (scope: { creatorId: string; productId: string }, session: Session) => Promise<string[]>;
  private opened = new Set<(scope: { creatorId: string; productId: string }, workspace: FactoryWorkspace) => void>();
  /** `journal` gives each Product workspace its own record of Runs, so every Run is recorded from its start, however it was started. */
  constructor(private root: string, private env: NodeJS.ProcessEnv, private models: ModelRoleResolver, private definitions?: AgentDefinitionRepository, private journal?: () => Journal, private usage?: UsageRecorder, private usageCap?: UsageCap) {}
  /** The Assistant observes every Product workspace it opens. */
  attachAssistant(hooks: { withheldTools: (scope: { creatorId: string; productId: string }, session: Session) => Promise<string[]>; opened: (scope: { creatorId: string; productId: string }, workspace: FactoryWorkspace) => void }): void {
    this.withheldTools = hooks.withheldTools;
    this.opened.add(hooks.opened);
  }
  /** The same Product workspace Studio uses; the token authorizes its Registry and Runtime calls. */
  async workspace(scope: { creatorId: string; productId: string; briefSpec?: unknown }, token: string): Promise<FactoryWorkspace> { return this.app(scope, token); }
  private async app(scope: { creatorId: string; productId: string; briefSpec?: unknown }, token: string) {
    const { creatorId, productId } = scope;
    if (!this.definitions) throw Object.assign(new Error("Factory Agent definitions require Registry database configuration"), { code: "agent_definitions_unavailable", status: 503 });
    if (!/^[a-zA-Z0-9_-]+$/.test(creatorId)) throw new Error("Invalid Creator ID");
    if (!/^[a-zA-Z0-9_-]+$/.test(productId)) throw new Error("Invalid Product ID");
    const key = `${creatorId}/${productId}`;
    let pending = this.products.get(key);
    if (!pending) {
      pending = createFactoryHandler({ root: path.join(this.root, creatorId, productId), scope, definitions: this.definitions, models: this.models, runtime: { ...(this.journal ? { journal: this.journal() } : {}), ...(this.usage ? { usage: { recorder: this.usage, accountId: creatorId, cap: this.usageCap } } : {}) }, withheldTools: async session => await this.withheldTools?.({ creatorId, productId }, session) ?? [], env: {
        ...this.env,
        HATCH_FACTORY_AUTH_TOKEN: undefined,
        HATCH_FACTORY_CREATOR_TOKEN: token,
        HATCH_FACTORY_CREATOR_ID: creatorId,
        HATCH_FACTORY_PRODUCT_ID: productId,
        HATCH_FACTORY_REGISTRY_URL: this.env.HATCH_FACTORY_REGISTRY_URL ?? `http://127.0.0.1:${this.env.REGISTRY_PORT ?? 8100}`,
        HATCH_FACTORY_RUNTIME_URL: this.env.HATCH_FACTORY_RUNTIME_URL ?? "wss://hatch.tokenquadrant.cn/v1/runtime",
      } });
      this.products.set(key, pending);
      pending.catch(() => this.products.delete(key));
      void pending.then(app => { for (const opened of this.opened) opened({ creatorId, productId }, app); }, () => undefined);
    }
    const app = await pending;
    app.setScope(scope);
    app.setCreatorToken(token);
    return app;
  }
  async handle(scope: { creatorId: string; productId: string; briefSpec?: unknown }, token: string, request: IncomingMessage, response: ServerResponse) {
    const app = await this.app(scope, token);
    const original = request.url;
    request.url = original?.replace(/^\/v1\/creator\/products\/[^/]+\/factory-agents(?=\/|$)/, "/api");
    try { await app.handle(request, response); } finally { request.url = original; }
  }
  async drain() { await Promise.all([...this.products.values()].map(async app => (await app).runtime.drain())); }
  async close() { await Promise.all([...this.products.values()].map(async app => (await app).close())); }
}
