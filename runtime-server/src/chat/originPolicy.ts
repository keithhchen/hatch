export const SESSION_COOKIE = "hatch_session";
const CREDENTIAL_PARAMETERS = ["api_key", "apikey", "token", "auth_token", "access_token", "key"];

export type UpgradeRequest = { origin?: string; cookie?: string; url: string };
export type UpgradeVerdict = { ok: true } | { ok: false; status: number; code: string; message: string };

export function sessionTokenFromCookie(cookie: string | undefined, name = SESSION_COOKIE): string | undefined {
  for (const part of (cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name && value.length) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

/**
 * A browser sends its cookie on a cross-site WebSocket upgrade, so cookie auth
 * must come from an allowed Origin. An API key is never accepted in a URL: URLs
 * end up in logs. Keys go in the Authorization header or the first message.
 */
export function checkUpgrade(request: UpgradeRequest, allowedOrigins: readonly string[], cookieName = SESSION_COOKIE): UpgradeVerdict {
  const query = new URL(request.url, "http://runtime.invalid").searchParams;
  if (CREDENTIAL_PARAMETERS.some((name) => query.has(name))) {
    return { ok: false, status: 400, code: "credential_in_url", message: "Send credentials in the Authorization header or the first message, never in the URL." };
  }
  if (sessionTokenFromCookie(request.cookie, cookieName) && !(request.origin && allowedOrigins.includes(request.origin))) {
    return { ok: false, status: 403, code: "origin_not_allowed", message: "This origin may not use a browser session." };
  }
  return { ok: true };
}
