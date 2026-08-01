import { z } from "zod";

const ResultSchema = z.object({
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  score: z.number().nullable().default(null)
}).strict();

const ResponseSchema = z.object({ data: z.array(ResultSchema) }).strict();

export type AgentKnowledgeSearch = {
  search(input: { query: string; max_num_results?: number }): Promise<Record<string, unknown>>;
};

export type AgentKnowledgeSearchResolver = {
  forAgent(tenantId: string, agentId: string): AgentKnowledgeSearch;
};

/**
 * The Runtime sees an already-scoped search capability, never a vector-store
 * identifier or an embedding credential. Registry owns the Agent → KB binding
 * and its provider implementation (Bailian in production).
 */
export class RegistryAgentKnowledgeSearch implements AgentKnowledgeSearchResolver {
  constructor(private readonly options: {
    registryUrl: string;
    serviceToken: string;
    timeoutMs?: number;
  }) {}

  forAgent(tenantId: string, agentId: string): AgentKnowledgeSearch {
    return {
      search: async ({ query, max_num_results = 6 }) => {
        const base = this.options.registryUrl.replace(/\/$/, "");
        const response = await fetch(
          `${base}/v1/runtime/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/knowledge/search`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.options.serviceToken}`,
              "x-hatch-tenant-id": tenantId,
              "content-type": "application/json",
              accept: "application/json"
            },
            body: JSON.stringify({ query, max_num_results }),
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000)
          }
        );
        const body = await response.text();
        if (!response.ok) {
          throw new Error(`Agent knowledge search failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
        }
        return ResponseSchema.parse(JSON.parse(body));
      }
    };
  }
}

export function registryAgentKnowledgeSearchFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): RegistryAgentKnowledgeSearch | undefined {
  const registryUrl = environment.HATCH_REGISTRY_URL?.trim();
  const serviceToken = environment.HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN?.trim();
  if (!registryUrl && !serviceToken) return undefined;
  if (!registryUrl || !serviceToken) {
    throw new Error("HATCH_REGISTRY_URL and HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN must be configured together for Agent knowledge search");
  }
  return new RegistryAgentKnowledgeSearch({ registryUrl, serviceToken });
}
