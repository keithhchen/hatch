let access = null;
let me = null;

/** On an artifact page, start what it needs at once: its code, the signed-in profile and the Product-access list. */
export function startEarlyLoad(pathname, request, load = () => import("./ArtifactPage.jsx")) {
  if (!pathname.startsWith("/artifact/")) return;
  access = request("/v1/user/product-access");
  access.catch(() => {});
  me = request("/v1/auth/me");
  me.catch(() => {});
  load().catch(() => {}); // a failed chunk surfaces (and reloads) where the page lazy-loads it
}

/** The early Product-access request, once; null when there is none. */
export function takeEarlyAccess() {
  const taken = access;
  access = null;
  return taken;
}

/** The early /v1/auth/me request, once; null when there is none. */
export function takeEarlyMe() {
  const taken = me;
  me = null;
  return taken;
}
