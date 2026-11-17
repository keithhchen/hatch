let agent = null;
let me = null;

/** The Agent behind a Product: the one request chat and artifact pages share, open to guests. */
export const productAgentUrl = productId => `/v1/web-chat/products/${encodeURIComponent(productId)}/agent`;

/** On an artifact page, start what it needs at once: its code, the signed-in profile and the Product's Agent. */
export function startEarlyLoad(pathname, request, load = () => import("./ArtifactPage.jsx")) {
  if (!pathname.startsWith("/artifact/")) return;
  const productId = pathname.split("/")[2];
  agent = { productId, promise: request(productAgentUrl(productId)) };
  agent.promise.catch(() => {});
  me = request("/v1/auth/me");
  me.catch(() => {});
  load().catch(() => {}); // a failed chunk surfaces (and reloads) where the page lazy-loads it
}

/** The early Agent request for this Product, once; null when there is none. */
export function takeEarlyAgent(productId) {
  const taken = agent?.productId === productId ? agent.promise : null;
  if (taken) agent = null;
  return taken;
}

/** The early /v1/auth/me request, once; null when there is none. */
export function takeEarlyMe() {
  const taken = me;
  me = null;
  return taken;
}
