import { createHash } from "node:crypto";
import { BoxNameTaken, type AgentBox, type BoxProvider } from "./ports.js";

/** Whose box it is: one per buyer per Product. `buyer` is the buyer's account id, or an IM contact's key. */
export type BoxOwner = { productId: string; buyer: string };

/** Deterministic and short: the owner's ids may hold anything, the name only [a-z0-9-]. */
export const boxName = ({ productId, buyer }: BoxOwner): string =>
  `hatch-${createHash("sha256").update(`${productId}\n${buyer}`).digest("hex").slice(0, 40)}`;

/** How long an opened box is reused before it is looked up again: every lookup is a request, and the service rate-limits requests. */
export const BOX_HANDLE_TTL_MS = 5 * 60_000;

/**
 * Get-or-create of a buyer's box. The opened box is kept for BOX_HANDLE_TTL_MS, so the tool calls of one turn, and of the
 * next turns, share one lookup and never create two boxes; a failed open is not kept. A create that loses a race to another
 * process finds the box it lost to.
 */
export class AgentBoxes {
  private readonly opened = new Map<string, { box: Promise<AgentBox>; until: number }>();
  constructor(private readonly provider: BoxProvider, private readonly ttlMs = BOX_HANDLE_TTL_MS, private readonly now = Date.now) {}

  of(owner: BoxOwner): Promise<AgentBox> {
    const name = boxName(owner);
    const kept = this.opened.get(name);
    if (kept && kept.until > this.now()) return kept.box;
    const box = this.open(name);
    const entry = { box, until: this.now() + this.ttlMs };
    this.opened.set(name, entry);
    box.catch(() => { if (this.opened.get(name) === entry) this.opened.delete(name); });
    return box;
  }

  private async open(name: string): Promise<AgentBox> {
    const found = await this.provider.find(name);
    if (found) return found;
    try {
      return await this.provider.create(name);
    } catch (error) {
      if (!(error instanceof BoxNameTaken)) throw error;
      const raced = await this.provider.find(name);
      if (raced) return raced;
      throw error;
    }
  }
}
