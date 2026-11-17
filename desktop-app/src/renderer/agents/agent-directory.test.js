import { describe, expect, it } from "vitest";
import { fetchAgents } from "./agent-directory.js";

const creator = { id: "8bb7b10c-4db0-4d8a-8c2f-2e2c8cba1002", name: "Ada" };
const owned = { creator_id: creator.id, product_id: "9cc7b10c-4db0-4d8a-8c2f-2e2c8cba1003", creator, product: { id: "9cc7b10c-4db0-4d8a-8c2f-2e2c8cba1003", name: "Ada's Agent", brief_spec: { fields: [{ id: "goal", label: "Goal", required: true }] } } };
const acquired = { ...owned, entitlement_id: "7aa7b10c-4db0-4d8a-8c2f-2e2c8cba1001", product_id: "6cc7b10c-4db0-4d8a-8c2f-2e2c8cba1004", product: { id: "6cc7b10c-4db0-4d8a-8c2f-2e2c8cba1004", name: "Bought" } };

const respond = payload => async () => ({ ok: true, status: 200, json: async () => payload });

describe("Agent directory", () => {
  it("binds every row by product and groups owned apart from library", async () => {
    const [mine, bought] = await fetchAgents("tok", { fetchImpl: respond({ creator_agents: [owned, acquired] }) });
    expect(mine).toMatchObject({ kind: "owned", key: `product:${owned.product_id}`, binding: { productId: owned.product_id }, name: "Ada's Agent", creatorName: "Ada" });
    expect(mine.briefFields).toHaveLength(1);
    expect(bought).toMatchObject({ kind: "acquired", key: `product:${acquired.product_id}`, binding: { productId: acquired.product_id } });
  });

  it("drops malformed rows and dedupes by product", async () => {
    const agents = await fetchAgents("tok", { fetchImpl: respond({ creator_agents: [owned, owned, { ...owned, entitlement_id: acquired.entitlement_id }, { product_id: "x" }] }) });
    expect(agents.map(agent => agent.key)).toEqual([`product:${owned.product_id}`]);
  });

  it("rejects a malformed list", async () => {
    await expect(fetchAgents("tok", { fetchImpl: respond({}) })).rejects.toMatchObject({ code: "agents_invalid" });
  });
});
