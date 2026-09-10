import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createFactoryHandler } from "./server.js";

export class FactoryAgentsService {
  private products = new Map<string, ReturnType<typeof createFactoryHandler>>();
  constructor(private root: string, private env: NodeJS.ProcessEnv) {}
  async handle(scope: { creatorId: string; productId: string; briefSpec?: unknown }, token: string, request: IncomingMessage, response: ServerResponse) {
    const { creatorId, productId } = scope;
    if (!/^[a-zA-Z0-9_-]+$/.test(creatorId)) throw new Error("Invalid Creator ID");
    if (!/^[a-zA-Z0-9_-]+$/.test(productId)) throw new Error("Invalid Product ID");
    const key = `${creatorId}/${productId}`;
    let pending = this.products.get(key);
    if (!pending) {
      pending = createFactoryHandler({ root: path.join(this.root, creatorId, productId), scope, env: {
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
    }
    const app = await pending;
    app.setCreatorToken(token);
    const original = request.url;
    request.url = original?.replace(/^\/v1\/creator\/products\/[^/]+\/factory-agents(?=\/|$)/, "/api");
    try { await app.handle(request, response); } finally { request.url = original; }
  }
  async close() { await Promise.all([...this.products.values()].map(async app => (await app).close())); }
}
