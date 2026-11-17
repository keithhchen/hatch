import { FreeChatMeter, resolveCreatorIdentity } from "@hatch/chat";
import { HATCH_ORIGIN } from "../config.js";
import { HatchRequestError, requestJson } from "../http.js";
import { isUuidV4 } from "../identity.js";

/**
 * One Agent the account can chat with, always addressed by `product_id`.
 * `kind` only groups the Library: a row with no `entitlement_id` is owned
 * (published by this account), otherwise it is a saved library Agent.
 */
export class AgentAccess {
  constructor(row) {
    const owned = !row.entitlement_id;
    this.kind = owned ? "owned" : "acquired";
    this.productId = row.product_id;
    this.creatorId = row.creator_id;
    this.key = `product:${row.product_id}`;
    this.binding = Object.freeze({ productId: row.product_id });
    this.identity = resolveCreatorIdentity({ access: row });
    this.briefFields = this.identity.briefSpec?.fields ?? [];
    // Mutable meter on a frozen Agent: owners chat freely, customers meet the expert's limit.
    this.freeChat = new FreeChatMeter(owned ? null : row.product?.pricing ?? null);
    // Acquired rows describe the Agent by its promise, like the Web catalog cards.
    this.description = [row.product?.description, row.product?.promise].find(text => typeof text === "string" && text.trim())?.trim() ?? "";
    Object.freeze(this);
  }

  get name() {
    return this.identity.productName;
  }

  get creatorName() {
    return this.identity.creatorName;
  }

  static isValidRow(row) {
    return isUuidV4(row?.product_id) && isUuidV4(row?.creator_id)
      && Boolean(row.product?.name) && Boolean(row.creator?.name);
  }
}

/**
 * The account's Agents, read from the shared Web/Desktop access view
 * `GET /v1/user/product-access`: owned rows first (published Products, no
 * entitlement), then library rows, one Agent per product, each with the creator's current name and
 * avatar. Runtime re-authorizes every conversation request regardless of
 * what this list says.
 */
export async function fetchAgents(token, { fetchImpl = fetch } = {}) {
  const payload = await requestJson(new URL("/v1/user/product-access", HATCH_ORIGIN), { token, fetchImpl });
  if (!Array.isArray(payload?.creator_agents)) throw new HatchRequestError("agents_invalid", "The Agent list is invalid.");
  const seen = new Set();
  return payload.creator_agents.filter(AgentAccess.isValidRow).map(row => new AgentAccess(row)).filter(agent => {
    if (seen.has(agent.key)) return false;
    seen.add(agent.key);
    return true;
  });
}
