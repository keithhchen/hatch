import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createFactoryHandler } from "./server.js";

export class FactoryAgentsService {
  private creators = new Map<string, ReturnType<typeof createFactoryHandler>>();
  constructor(private root: string, private env: NodeJS.ProcessEnv) {}
  async handle(creatorId: string, token: string, request: IncomingMessage, response: ServerResponse) {
    if (!/^[a-zA-Z0-9_-]+$/.test(creatorId)) throw new Error("Invalid Creator ID");
    let pending = this.creators.get(creatorId);
    if (!pending) {
      pending = createFactoryHandler({ root: path.join(this.root, creatorId), env: {
        ...this.env,
        HATCH_FACTORY_AUTH_TOKEN: undefined,
        HATCH_FACTORY_CREATOR_TOKEN: token,
        HATCH_FACTORY_REGISTRY_URL: this.env.HATCH_FACTORY_REGISTRY_URL ?? `http://127.0.0.1:${this.env.REGISTRY_PORT ?? 8100}`,
        HATCH_FACTORY_RUNTIME_URL: this.env.HATCH_FACTORY_RUNTIME_URL ?? "wss://hatch.tokenquadrant.cn/v1/runtime",
      } });
      this.creators.set(creatorId, pending);
      pending.catch(() => this.creators.delete(creatorId));
    }
    const app = await pending;
    app.setCreatorToken(token);
    const original = request.url;
    request.url = original?.replace(/^\/v1\/creator\/factory-agents(?=\/|$)/, "/api");
    try { await app.handle(request, response); } finally { request.url = original; }
  }
  async close() { await Promise.all([...this.creators.values()].map(async app => (await app).close())); }
}
