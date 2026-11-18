import { WebChatRoute } from "./webChatRoute.js";

let access = null;
let me = null;

const ME = "/v1/auth/me";
const ACCESS = "/v1/user/product-access";
const CHUNKS = {
  artifact: () => import("./ArtifactPage.jsx"),
  chat: () => import("./WebChatPage.jsx"),
  studio: () => import("./CreatorPortalV2.jsx"),
  studioAgent: () => import("./studioAgentWorkspace.jsx")
};

/** What each signed-in route needs at once; the first matching row wins. Public pages have no row. */
const ROUTES = [
  { match: (p) => p.startsWith("/artifact/"), requests: [ACCESS, ME], chunks: ["artifact"] },
  { match: (p) => Boolean(WebChatRoute.parse(p)), requests: [ACCESS, ME], chunks: ["chat"] },
  { match: (p) => p.startsWith("/studio/agents/"), requests: [ME], chunks: ["studio", "studioAgent"] },
  { match: (p) => p === "/studio" || p.startsWith("/studio/"), requests: [ME], chunks: ["studio"] },
  { match: (p) => p === "/desktop/sign-in", requests: [ME], chunks: [] }
];

/** Start the profile, Product-access list and route code the page will need, before React renders. */
export function startEarlyLoad(pathname, request, chunks = CHUNKS) {
  const route = ROUTES.find(({ match }) => match(pathname));
  if (!route) return;
  for (const url of route.requests) {
    const started = request(url);
    started.catch(() => {}); // the consumer sees the failure when it takes the promise
    if (url === ME) me = started;
    else access = started;
  }
  // a failed chunk surfaces (and reloads) where the page lazy-loads it
  for (const name of route.chunks) chunks[name]().catch(() => {});
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
