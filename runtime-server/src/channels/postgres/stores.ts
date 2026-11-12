import type { Pool } from "pg";
import type { ChannelStores } from "../service.js";
import type { ChannelKind } from "../types.js";
import { PostgresConnections } from "./connections.js";
import { PostgresInbox } from "./inbox.js";
import { PostgresOutbox } from "./outbox.js";
import { PostgresRateLimiter } from "./rateLimiter.js";

export async function openChannelStores(pool: Pool, scopeOf: (ownerAccountId: string, channel: ChannelKind) => string): Promise<ChannelStores> {
  const connections = await PostgresConnections.open(pool, scopeOf);
  // Each table references hatch_connections, so it exists first.
  return { connections, inbox: await PostgresInbox.open(pool), outbox: await PostgresOutbox.open(pool), limiter: await PostgresRateLimiter.open(pool) };
}
