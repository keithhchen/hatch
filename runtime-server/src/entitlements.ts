import { readFile } from "node:fs/promises";
import { z } from "zod";

const EntitlementIdentitySchema = z.object({
  entitlement_id: z.string().min(1),
  order_id: z.string().min(1),
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  creator_id: z.string().min(1),
  product_id: z.string().min(1),
  status: z.literal("active")
});

/** The production entitlement: it authorizes one current Agent Corpus. */
export const AgentEntitlementBindingSchema = EntitlementIdentitySchema.extend({
  agent_id: z.string().min(1)
}).strict();

export const EntitlementBindingSchema = AgentEntitlementBindingSchema;

export type AgentEntitlementBinding = z.infer<typeof AgentEntitlementBindingSchema>;
export type EntitlementBinding = AgentEntitlementBinding;

export type EntitlementLookup = {
  licenseToken: string;
  entitlementId?: string;
  installationId?: string;
};

export interface EntitlementResolver {
  list(input: EntitlementLookup): Promise<EntitlementBinding[]>;
  resolve(input: EntitlementLookup & { entitlementId: string }): Promise<EntitlementBinding>;
}

/**
 * Development adapter for an exported commerce entitlement projection.
 * The file is server-side and maps opaque license tokens to active bindings;
 * neither the Desktop nor an Agent Corpus can choose a different identity.
 */
export class FileEntitlementResolver implements EntitlementResolver {
  constructor(private readonly filePath: string) {}

  async list(input: EntitlementLookup): Promise<EntitlementBinding[]> {
    const registry = await this.readRegistry();
    return registry
      .filter((entry) => entry.license_token === input.licenseToken)
      .map(({ license_token: _licenseToken, ...binding }) => binding);
  }

  async resolve(input: EntitlementLookup & { entitlementId: string }): Promise<EntitlementBinding> {
    const binding = (await this.list(input)).find((entry) => entry.entitlement_id === input.entitlementId);
    if (!binding) throw new EntitlementError("entitlement_not_found", "This Creator Agent is not available for the signed-in account.");
    return binding;
  }

  private async readRegistry(): Promise<Array<EntitlementBinding & { license_token: string }>> {
    const payload = JSON.parse(await readFile(this.filePath, "utf8"));
    return z.array(z.object({
      license_token: z.string().min(1)
    }).passthrough().transform((entry) => {
      const { license_token, ...binding } = entry;
      return { license_token, ...EntitlementBindingSchema.parse(binding) };
    })).parse(payload);
  }
}

export class EntitlementError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EntitlementError";
  }
}
