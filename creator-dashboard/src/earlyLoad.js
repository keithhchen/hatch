let access = null;

/** On an artifact page, start what it needs at once, beside /v1/auth/me: its code, and the Product-access list. */
export function startEarlyLoad(pathname, request, load = () => import("./ArtifactPage.jsx")) {
  if (!pathname.startsWith("/artifact/")) return;
  access = request("/v1/user/product-access");
  access.catch(() => {});
  load().catch(() => {}); // a failed chunk surfaces (and reloads) where the page lazy-loads it
}

/** The early Product-access request, once; null when there is none. */
export function takeEarlyAccess() {
  const taken = access;
  access = null;
  return taken;
}
