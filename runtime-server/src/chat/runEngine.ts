import type { ProductCapabilities } from "../agentBox/capabilities.js";
import type { TurnRunner } from "./turnExecutor.js";

/**
 * Where a Product Run is executed. The pi runtime (our own agent loop and box) is one engine; Kimi Hosted Agents is another.
 * An engine owns the Run from `state.start()` to its ending, and reports any failure through the Run's one exit.
 */
export type RunEngine<Scope> = TurnRunner<Scope>;

/** A Product that runs on Kimi Hosted Agents: set by a row in hatch_product_capabilities, read on every Run. */
export const KIMI_HOSTED_ENGINE_CAPABILITY = "engine_kimi_hosted";

/**
 * The one dispatch point: a Product with the capability row runs on `alternative`, every other Product on `standard`.
 * The row is read per Run, so inserting or deleting it flips the next Run with no deploy.
 */
export class SwitchedEngine<Scope extends { productId: string }> implements RunEngine<Scope> {
  constructor(private readonly deps: { capabilities: Pick<ProductCapabilities, "has"> | undefined; capability: string; standard: RunEngine<Scope>; alternative: RunEngine<Scope> }) {}

  async run(turn: Parameters<RunEngine<Scope>["run"]>[0]): Promise<void> {
    const { capabilities, capability, standard, alternative } = this.deps;
    // Without a capability store (no database) no Product can have the row: the standard engine, as before.
    const chosen = capabilities && await capabilities.has(turn.scope.productId, capability) ? alternative : standard;
    return chosen.run(turn);
  }
}
