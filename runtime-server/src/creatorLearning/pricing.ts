/**
 * Expert-set free-chat offer shown to customers. These are display terms only:
 * Product access stays free, and nothing here creates orders or payments.
 * Unset fields are null; a free-message limit needs at least one paid option.
 */
export type ProductPricing = {
  free_messages: number | null;
  human_hourly_minor: number | null;
  agent_monthly_minor: number | null;
  currency: "USD";
};

export const EMPTY_PRODUCT_PRICING: ProductPricing = Object.freeze({
  free_messages: null,
  human_hourly_minor: null,
  agent_monthly_minor: null,
  currency: "USD"
}) as ProductPricing;

export class ProductPricingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProductPricingError";
  }
}

const optionalInteger = (max: number) => (value: unknown, label: string): number | null => {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new ProductPricingError("invalid_pricing", `${label} must be a whole number between 1 and ${max}`);
  }
  return value as number;
};

const messageCount = optionalInteger(1_000);
const minorAmount = optionalInteger(100_000_00);

export function normalizeProductPricing(input: unknown): ProductPricing {
  if (input === null || input === undefined) return EMPTY_PRODUCT_PRICING;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ProductPricingError("invalid_pricing", "pricing must be an object");
  }
  const value = input as Record<string, unknown>;
  if (value.currency !== undefined && value.currency !== "USD") {
    throw new ProductPricingError("invalid_pricing", "pricing.currency must be USD");
  }
  const pricing: ProductPricing = {
    free_messages: messageCount(value.free_messages, "free_messages"),
    human_hourly_minor: minorAmount(value.human_hourly_minor, "human_hourly_minor"),
    agent_monthly_minor: minorAmount(value.agent_monthly_minor, "agent_monthly_minor"),
    currency: "USD"
  };
  if (pricing.free_messages !== null && pricing.human_hourly_minor === null && pricing.agent_monthly_minor === null) {
    throw new ProductPricingError("payment_option_required", "A free-message limit needs a human expert hourly price or an agent monthly price");
  }
  return pricing;
}
