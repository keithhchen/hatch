import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCorpus, ResolvedAgentCorpus } from "./agentCorpus.js";
import type { CommerceEventSink } from "./delivery.js";
import type { EntitlementBinding } from "./entitlements.js";
import { resolveEntitledAgentCorpus } from "./entitlementVersion.js";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const C = `sha256:${"c".repeat(64)}`;

test("pinned entitlement always resolves its purchased release", async () => {
  const resolver = releaseResolver([release(A), release(B, A)], B);
  const commerce = new MemoryVersionCommerce(A);
  const selected = await resolveEntitledAgentCorpus(resolver, entitlement("pinned"), commerce);
  assert.equal(selected.digest, A);
  assert.equal(selected.purchased_corpus_digest, A);
  assert.equal(selected.effective_corpus_digest, A);
  assert.equal(commerce.commands.length, 0);
});

test("compatible current release advances Commerce before Runtime selects it", async () => {
  const resolver = releaseResolver([release(A), release(B, A)], B);
  const commerce = new MemoryVersionCommerce(A);
  const selected = await resolveEntitledAgentCorpus(
    resolver,
    entitlement("track_current_compatible"),
    commerce
  );
  assert.equal(selected.digest, B);
  assert.equal(selected.purchased_corpus_digest, A);
  assert.equal(selected.effective_corpus_digest, B);
  assert.deepEqual(commerce.commands.map((command) => [command.from_digest, command.to_digest]), [[A, B]]);
  assert.deepEqual(selected.version_history.map((item) => [item.from_digest, item.to_digest]), [[A, B]]);
});

test("breaking current release does not advance or replace the old effective release", async () => {
  const resolver = releaseResolver([release(A), release(B)], B);
  const commerce = new MemoryVersionCommerce(A);
  const selected = await resolveEntitledAgentCorpus(
    resolver,
    entitlement("track_current_compatible"),
    commerce
  );
  assert.equal(selected.digest, A);
  assert.equal(commerce.commands.length, 0);
});

test("Commerce failure fails closed on the old effective release", async () => {
  const resolver = releaseResolver([release(A), release(B, A)], B);
  const commerce = new MemoryVersionCommerce(A, true);
  const selected = await resolveEntitledAgentCorpus(
    resolver,
    entitlement("track_current_compatible"),
    commerce
  );
  assert.equal(selected.digest, A);
  assert.equal(selected.effective_corpus_digest, A);
});

test("transitive compatible advances replay idempotently without duplicate history", async () => {
  const resolver = releaseResolver([release(A), release(B, A), release(C, B)], C);
  const commerce = new MemoryVersionCommerce(A);
  const first = await resolveEntitledAgentCorpus(
    resolver,
    entitlement("track_current_compatible"),
    commerce
  );
  const replay = await resolveEntitledAgentCorpus(
    resolver,
    entitlement("track_current_compatible"),
    commerce
  );
  assert.equal(first.digest, C);
  assert.equal(replay.digest, C);
  assert.equal(commerce.history.length, 2);
  assert.deepEqual(commerce.history.map((item) => [item.from_digest, item.to_digest]), [[A, B], [B, C]]);
  assert.equal(new Set(commerce.idempotencyKeys).size, 2);
  assert.equal(commerce.commands.length, 3, "replay probes the first stable command and accepts the later projection");
});

function entitlement(versionPolicy: "pinned" | "track_current_compatible"): EntitlementBinding {
  return {
    entitlement_id: "ent-compatible",
    order_id: "order-compatible",
    user_id: "buyer-compatible",
    creator_id: "creator-compatible",
    agent_id: "agent-compatible",
    product_id: "product-compatible",
    purchased_corpus_digest: A,
    effective_corpus_digest: A,
    version_policy: versionPolicy,
    version_history: [],
    status: "active"
  };
}

function release(digest: string, predecessor?: string): ResolvedAgentCorpus {
  return {
    root: `/immutable/${digest}`,
    digest,
    corpus: {
      contract_version: "1",
      agent_id: "agent-compatible",
      creator: { id: "creator-compatible", name: "Compatible Creator" },
      ...(predecessor ? { release: { backward_compatible_with: predecessor } } : {}),
      product: {
        id: "product-compatible",
        name: "Compatible Product",
        boundaries: [],
        presentation: {}
      },
      instructions: {
        system: { id: "system", path: "instructions/system.md", sha256: A }
      },
      skills: [],
      knowledge: { documents: [] },
      tools: [{ id: "hatch.web_search", kind: "hatch_builtin" }],
      evaluations: {
        synthetic_qa: [{ id: "synthetic", path: "evals/synthetic.json", sha256: A }],
        held_out: [{ id: "held-out", path: "evals/held-out.json", sha256: A }]
      }
    } satisfies AgentCorpus
  };
}

function releaseResolver(releases: ResolvedAgentCorpus[], currentDigest: string) {
  const byDigest = new Map(releases.map((item) => [item.digest, item]));
  return {
    resolve: async (creatorId: string, agentId: string, digest?: string) => {
      if (creatorId !== "creator-compatible" || agentId !== "agent-compatible") throw new Error("scope mismatch");
      const resolved = byDigest.get(digest ?? currentDigest);
      if (!resolved) throw new Error("release unavailable");
      return resolved;
    }
  };
}

class MemoryVersionCommerce implements CommerceEventSink {
  readonly commands: Array<Parameters<NonNullable<CommerceEventSink["advanceEntitlementVersion"]>>[0]> = [];
  readonly idempotencyKeys = new Set<string>();
  readonly history: Array<{ from_digest: string; to_digest: string; advanced_at: string }> = [];
  private readonly replays = new Map<string, true>();

  constructor(private effectiveDigest: string, private readonly fail = false) {}

  async append(): Promise<unknown> { return {}; }

  async advanceEntitlementVersion(
    input: Parameters<NonNullable<CommerceEventSink["advanceEntitlementVersion"]>>[0],
    options: { idempotencyKey: string }
  ): Promise<unknown> {
    this.commands.push(input);
    this.idempotencyKeys.add(options.idempotencyKey);
    if (this.fail) throw new Error("Commerce unavailable");
    if (!this.replays.has(options.idempotencyKey)) {
      if (input.from_digest !== this.effectiveDigest) throw new Error("version chain broken");
      this.effectiveDigest = input.to_digest;
      this.history.push({
        from_digest: input.from_digest,
        to_digest: input.to_digest,
        advanced_at: "2026-08-12T00:00:00.000Z"
      });
      this.replays.set(options.idempotencyKey, true);
    }
    return {
      entitlement: {
        effective_corpus_digest: this.effectiveDigest,
        version_history: this.history
      }
    };
  }
}
