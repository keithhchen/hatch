import { WebChatRoute } from "./webChatRoute.js";

let agent = null;
let me = null;

const ME = "/v1/auth/me";
const CHUNKS = {
  artifact: () => import("./ArtifactPage.jsx"),
  chat: () => import("./WebChatPage.jsx"),
  studio: () => import("./CreatorPortalV2.jsx"),
  studioAgent: () => import("./studioAgentWorkspace.jsx")
};

/** The Agent behind a Product: the one request chat and artifact pages share, open to guests. */
export const productAgentUrl = productId => `/v1/web-chat/products/${encodeURIComponent(productId)}/agent`;

/** What each route needs at once; the first matching row wins. `agent` is the Product whose Agent it asks for. */
const ROUTES = [
  { match: (p) => p.startsWith("/artifact/"), agent: (p) => p.split("/")[2], requests: [ME], chunks: ["artifact"] },
  { match: (p) => Boolean(WebChatRoute.parse(p)), requests: [ME], chunks: ["chat"] },
  { match: (p) => p.startsWith("/studio/agents/"), requests: [ME], chunks: ["studio", "studioAgent"] },
  { match: (p) => p === "/studio" || p.startsWith("/studio/"), requests: [ME], chunks: ["studio"] },
  { match: (p) => p === "/desktop/sign-in", requests: [ME], chunks: [] }
];

/** Start the profile, the Product's Agent and route code the page will need, before React renders. */
export function startEarlyLoad(pathname, request, chunks = CHUNKS) {
  const route = ROUTES.find(({ match }) => match(pathname));
  if (!route) return;
  const start = (url) => {
    const started = request(url);
    started.catch(() => {}); // the consumer sees the failure when it takes the promise
    return started;
  };
  if (route.agent) {
    const productId = route.agent(pathname);
    agent = { productId, promise: start(productAgentUrl(productId)) };
  }
  for (const url of route.requests) me = start(url);
  // a failed chunk surfaces (and reloads) where the page lazy-loads it
  for (const name of route.chunks) chunks[name]().catch(() => {});
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
