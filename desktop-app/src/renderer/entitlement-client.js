export async function fetchPurchasedCreatorAgents(runtimeUrl, accessToken, fetchImpl = fetch) {
  const response = await fetchImpl(runtimeHttpUrl(runtimeUrl, "/v1/me/creator-agents"), {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || "We couldn't open your agents. Check your access code and try again.");
  }
  if (!Array.isArray(payload.creator_agents)) throw new Error("We couldn't open your agent library. Try again.");
  return payload.creator_agents.filter(isCreatorAgentEntitlement);
}

export function runtimeHttpUrl(runtimeUrl, pathname) {
  const url = new URL(runtimeUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = pathname;
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
