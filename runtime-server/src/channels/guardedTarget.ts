import type { Handled, Inbound, TargetHandler } from "./ports.js";

/** What to tell the sender when the Agent behind the Connection may not answer now; undefined lets the event through. */
export type Guard = (inbound: Inbound) => Promise<string | undefined>;

/** Checks eligibility before an Agent sees an event, so a Run is never started for a Connection that may not have one. */
export class GuardedTarget implements TargetHandler {
  constructor(private inner: TargetHandler, private guards: Guard[]) {}

  linked: TargetHandler["linked"] = connection => this.inner.linked(connection);

  async handle(inbound: Inbound): Promise<Handled> {
    for (const guard of this.guards) {
      const refusal = await guard(inbound);
      if (refusal) { await inbound.notify(refusal); return { replied: true }; }
    }
    return this.inner.handle(inbound);
  }
}

const UNAVAILABLE = "这位专家暂时不可用。\nThis Expert is not available right now.";

/** A Connection answers only with a Product that is live and its owner's own: it cannot lend someone else's Expert to an audience. */
export const liveOwnProduct = (releases: { getLive(productId: string): Promise<{ creator_id: string } | undefined> }): Guard => async ({ connection }) => {
  if (connection.target.kind !== "product") return undefined;
  const live = await releases.getLive(connection.target.productId);
  return live?.creator_id === connection.ownerAccountId ? undefined : UNAVAILABLE;
};
