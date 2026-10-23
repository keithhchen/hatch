import { corpusOutputSchema, type CorpusOutput } from "../corpusNode.js";

/**
 * Product Live domain. An Expert's Product goes live by publishing the Agent
 * definition the Builder saved. The only rule: SYSTEM.md must exist.
 * Knowledge stays empty until retrieval is rebuilt; Tools are none.
 */

export type Skill = CorpusOutput["skills"][number];
export type PendingChange = "corpus" | "brief";

export class ExpertProduct {
  constructor(
    readonly creatorId: string,
    readonly productId: string,
    readonly name: string,
    readonly promise: string,
    readonly briefSpec: unknown = null,
  ) {}

  get publicUrl(): string {
    return `/products/${encodeURIComponent(this.productId)}`;
  }
}

/** The publishable unit the runtime serves. Immutable and comparable by content. */
export class Corpus {
  private constructor(readonly value: CorpusOutput) {}

  static parse(input: unknown): Corpus {
    return new Corpus(corpusOutputSchema.parse(input));
  }

  equals(other: Corpus | null): boolean {
    return other !== null && canonicalJson(this.value) === canonicalJson(other.value);
  }
}

/** What the Agent Builder produced: the System prompt plus Skills. */
export class AgentDefinition {
  constructor(readonly system: string, readonly skills: readonly Skill[]) {}

  static whenPresent(system: string, skills: readonly Skill[]): AgentDefinition | null {
    return system.trim() ? new AgentDefinition(system, skills) : null;
  }

  toCorpus(): Corpus {
    return Corpus.parse({ system_instructions: this.system, skills: this.skills, knowledge: [], tools: [] });
  }
}

/** The release customers are talking to right now. */
export class LiveRelease {
  constructor(readonly corpus: Corpus | null, readonly briefSpec: unknown, readonly publishedAt: string) {}

  pendingAgainst(product: ExpertProduct, definition: AgentDefinition | null): PendingChange[] {
    const checks: Array<[PendingChange, boolean]> = [
      ["corpus", definition !== null && !definition.toCorpus().equals(this.corpus)],
      ["brief", canonicalJson(this.briefSpec ?? null) !== canonicalJson(product.briefSpec ?? null)],
    ];
    return checks.filter(([, differs]) => differs).map(([change]) => change);
  }
}

export type ProductLiveStatus = {
  product_id: string;
  can_publish: boolean;
  is_live: boolean;
  pending_changes: PendingChange[];
  public_url: string | null;
  published_at: string | null;
};

/** Read model combining the product, its saved definition and its live release. */
export class ProductLiveView {
  constructor(
    private readonly product: ExpertProduct,
    private readonly definition: AgentDefinition | null,
    private readonly live: LiveRelease | null,
  ) {}

  toJSON(): ProductLiveStatus {
    return {
      product_id: this.product.productId,
      can_publish: this.definition !== null,
      is_live: this.live !== null,
      pending_changes: this.live?.pendingAgainst(this.product, this.definition) ?? [],
      public_url: this.live ? this.product.publicUrl : null,
      published_at: this.live?.publishedAt ?? null,
    };
  }
}

export type PublishedProduct = {
  product_id: string;
  status: "published";
  published_at: string;
  corpus_digest: string;
  public_url: string;
};

export class SystemMissing extends Error {
  readonly code = "system_missing";
  constructor() {
    super("SYSTEM.md does not exist yet. Finish the Agent Builder step first.");
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : entry
  ));
}
