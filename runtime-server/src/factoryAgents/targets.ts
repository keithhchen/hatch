import { z } from "zod";
import { registryRequest } from "./corpusTools.js";
import type { WorkbenchStore, TargetBinding } from "./store.js";

export type EvaluationTarget = {
  name: string; productId: string; creatorId: string;
  entitlementId?: string; available: boolean; reason?: string; briefSpec?: unknown;
};

/** Registry is the authority for the signed-in Creator’s published Agents. */
export async function evaluationTargets(store: WorkbenchStore, env: NodeJS.ProcessEnv): Promise<{ targets: EvaluationTarget[]; unavailable?: string }> {
  const targets: EvaluationTarget[] = [];
  let unavailable: string | undefined;
  if (env.HATCH_FACTORY_CREATOR_TOKEN && env.HATCH_FACTORY_REGISTRY_URL && env.HATCH_FACTORY_RUNTIME_URL) {
    // Registry owns the Product catalog; Runtime's release resolver intentionally has no catalog.
    const body = z.object({ products: z.array(z.object({
      creator_id: z.string(), product_id: z.string(), name: z.string(), status: z.string(),
      brief_spec: z.unknown().optional(),
      release: z.object({ corpus_digest: z.string(), brief_spec: z.unknown().optional() }).nullish(),
    })) }).parse(await registryRequest(env, "/v1/creator/products"));
    for (const row of body.products) {
      if (row.status !== "published" || !row.release) continue;
      targets.push({ name: row.name, creatorId: row.creator_id, productId: row.product_id, available: true, briefSpec: row.release.brief_spec ?? row.brief_spec });
    }
  } else unavailable = "Creator 的 Agent 列表或 Runtime 服务不可用";
  return { targets, ...(unavailable ? { unavailable } : {}) };
}

export async function resolveEvaluationTarget(store: WorkbenchStore, env: NodeJS.ProcessEnv, selection: { entitlementId?: string; productId: string; briefAnswers?: TargetBinding["briefAnswers"] }): Promise<TargetBinding> {
  const { targets } = await evaluationTargets(store, env);
  const target = targets.find(t => t.available && t.entitlementId === selection.entitlementId && t.productId === selection.productId);
  if (!target || !env.HATCH_FACTORY_RUNTIME_URL) throw new Error("Selected Agent is unavailable; refresh the list");
  return { runtimeUrl: env.HATCH_FACTORY_RUNTIME_URL, entitlementId: selection.entitlementId, creatorId: target.creatorId, productId: target.productId, briefSpec: target.briefSpec, briefAnswers: selection.briefAnswers ?? [] };
}
