export async function fetchPurchasedCreatorAgents(registryUrl, authToken, fetchImpl = fetch) {
  const accessResponse = await fetchImpl(new URL("/v1/user/agent-access", registryUrl).toString(), {
    headers: { authorization: `Bearer ${authToken}` }
  });
  const accessPayload = await accessResponse.json().catch(() => ({}));
  if (!accessResponse.ok) {
    throw new Error(accessPayload?.detail || "We couldn't open your agents. Try signing in again.");
  }
  if (!Array.isArray(accessPayload)) throw new Error("We couldn't open your agent library. Try again.");
  const catalogResponse = await fetchImpl(new URL("/v1/catalog/agents", registryUrl).toString(), {
    headers: { accept: "application/json" }
  });
  const catalogPayload = await catalogResponse.json().catch(() => ({}));
  if (!catalogResponse.ok || !Array.isArray(catalogPayload)) {
    throw new Error(catalogPayload?.detail || "We couldn't load the Agent catalog. Try again.");
  }
  const catalog = new Map(catalogPayload.map((entry) => [
    `${entry?.creator_id}:${entry?.agent_id}`,
    entry
  ]));
  return accessPayload.map((grant) => {
    const entry = catalog.get(`${grant?.creator_id}:${grant?.agent_id}`);
    if (!entry) return null;
    return {
      ...grant,
      creator: { id: entry.creator_id, name: entry.creator_name },
      product: {
        id: entry.product_id,
        name: entry.product_name,
        description: entry.product_description || "Work with this Creator Agent in your own files and context."
      },
      ...(entry.voice ? { voice: entry.voice } : {}),
      presentation: {}
    };
  }).filter(isCreatorAgentEntitlement);
}

export function runtimeHttpUrl(runtimeUrl, pathname) {
  const url = new URL(runtimeUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function voiceTtsUrl(runtimeUrl) {
  const url = new URL("/v1/tts", runtimeUrl);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isCreatorAgentEntitlement(value) {
  return Boolean(
    value?.entitlement_id
    && value?.creator?.id
    && value?.creator?.name
    && value?.product?.id
    && value?.product?.name
  );
}
