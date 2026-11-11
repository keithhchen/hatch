import type { ChannelConnection } from "./connections.js";
import type { TargetHandler } from "./ports.js";
import type { ChannelKind } from "./types.js";

/** A platform's rules about who may be served on it. Throws when the Connection may not use the platform. */
export type Eligibility = (connection: ChannelConnection) => void;

export class ChannelPolicyError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Puts each platform's eligibility rule in front of an Agent, so the core carries no platform branch. */
export const guarded = (handler: TargetHandler, rules: Partial<Record<ChannelKind, Eligibility>>): TargetHandler => ({
  async handle(inbound) { rules[inbound.connection.channel as ChannelKind]?.(inbound.connection); return handler.handle(inbound); },
  async linked(connection) { rules[connection.channel as ChannelKind]?.(connection); return handler.linked(connection); },
  ...(handler.replyPolicy ? { replyPolicy: (connection, runId) => handler.replyPolicy!(connection, runId) } : {}),
});
