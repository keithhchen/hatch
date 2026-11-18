import { createHash } from "node:crypto";
import { BoxNameTaken, type AgentBox, type BoxProvider } from "./ports.js";

/** Whose box it is: one per buyer per Product. `buyer` is the buyer's account id, or an IM contact's key. */
export type BoxOwner = { productId: string; buyer: string };

/** Deterministic and short: the owner's ids may hold anything, the name only [a-z0-9-]. */
export const boxName = ({ productId, buyer }: BoxOwner): string =>
  `hatch-${createHash("sha256").update(`${productId}\n${buyer}`).digest("hex").slice(0, 40)}`;

/**
 * Get-or-create of a buyer's box. Calls that arrive together share one lookup, so two tool calls of one turn never create two
 * boxes; a create that loses a race to another process finds the box it lost to.
 */
export class AgentBoxes {
  private readonly pending = new Map<string, Promise<AgentBox>>();
  constructor(private readonly provider: BoxProvider) {}

  of(owner: BoxOwner): Promise<AgentBox> {
    const name = boxName(owner);
    let opening = this.pending.get(name);
    if (!opening) {
      opening = this.open(name).finally(() => this.pending.delete(name));
      this.pending.set(name, opening);
    }
    return opening;
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
