const env = import.meta.env ?? {};

/** Public Hatch origin: Registry auth, the Dashboard and the web catalog. */
export const HATCH_ORIGIN = env.VITE_HATCH_AUTH_URL || "https://hatch.tokenquadrant.cn";
/** Runtime WebSocket; Runtime HTTP APIs share its host. */
export const RUNTIME_SOCKET_URL = env.VITE_HATCH_RUNTIME_URL || "wss://hatch.tokenquadrant.cn/v1/runtime";
export const EXPLORE_URL = env.VITE_HATCH_CATALOG_URL || `${HATCH_ORIGIN}/explore`;
export const ACCOUNT_URL = `${HATCH_ORIGIN}/account`;
export const DESKTOP_SIGN_IN_URL = `${HATCH_ORIGIN}/desktop/sign-in`;
export const PROTOCOL_VERSION = "0.8";
export const MAX_ATTACHMENTS = 8;

export const PLATFORM = /Mac/i.test(globalThis.navigator?.userAgent ?? "") ? "macos" : "windows";

/** Runtime HTTP URL for a path on the Runtime WebSocket host. */
export function runtimeHttpUrl(pathname, runtimeUrl = RUNTIME_SOCKET_URL) {
  const url = new URL(runtimeUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url;
}
