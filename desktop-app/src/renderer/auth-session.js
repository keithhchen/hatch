import { englishMessage } from "./i18n.js";
import { isUuidV4 } from "./identity.js";

export async function signInAuthSession({ email, password }, registryUrl, fetchImpl = fetch) {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  const normalizedPassword = String(password ?? "");
  if (!normalizedEmail) throw localizedError(englishMessage("error.auth.emailRequired"), "error.auth.emailRequired");
  if (!normalizedPassword) throw localizedError(englishMessage("error.auth.passwordRequired"), "error.auth.passwordRequired");

  let response;
  try {
    response = await fetchImpl(new URL("/v1/auth/signin", registryUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email: normalizedEmail, password: normalizedPassword })
    });
  } catch (error) {
    throw clientError(
      englishMessage("error.network.unreachable"),
      "network_error",
      error,
      undefined,
      "error.network.unreachable"
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const invalidCredentials = response.status === 401;
    throw clientError(
      payload?.detail || englishMessage(invalidCredentials ? "error.auth.invalidCredentials" : "error.auth.signInFailed"),
      invalidCredentials ? "invalid_credentials" : "auth_request_failed",
      null,
      response.status,
      invalidCredentials ? "error.auth.invalidCredentials" : "error.auth.signInFailed"
    );
  }
  const token = payload?.session?.token || payload?.token;
  if (!payload?.account?.role || !isUuidV4(payload?.account?.id) || !token) {
    throw clientError(
      englishMessage("error.auth.invalidAccount"),
      "auth_request_failed",
      null,
      undefined,
      "error.auth.invalidAccount"
    );
  }
  return makeSessionFromAccount(payload.account, token, payload.session?.expires_at);
}

export async function fetchAuthAccount(registryUrl, accessToken, fetchImpl = fetch) {
  if (!accessToken) {
    throw clientError(
      englishMessage("error.auth.invalidSession"),
      "auth_invalid",
      null,
      401,
      "error.auth.invalidSession"
    );
  }
  let response;
  try {
    response = await fetchImpl(new URL("/v1/auth/me", registryUrl).toString(), {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
    });
  } catch (error) {
    throw clientError(
      englishMessage("error.network.unreachable"),
      "network_error",
      error,
      undefined,
      "error.network.unreachable"
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = response.status === 401 ? "auth_invalid" : "auth_request_failed";
    throw clientError(
      payload?.detail || englishMessage(response.status === 401 ? "error.auth.invalidSession" : "error.auth.verifyFailed"),
      code,
      null,
      response.status,
      response.status === 401 ? "error.auth.invalidSession" : "error.auth.verifyFailed"
    );
  }
  if (!isUuidV4(payload?.id) || !payload?.role || !["user", "creator"].includes(payload.role)) {
    throw clientError(
      englishMessage("error.auth.invalidAccount"),
      "auth_request_failed",
      null,
      undefined,
      "error.auth.invalidAccount"
    );
  }
  return payload;
}

export async function loadSavedAuthSession(storage) {
  if (!storage?.readToken) return null;
  try {
    const accessToken = await storage.readToken();
    return accessToken ? Object.freeze({ accessToken }) : null;
  } catch {
    // A missing or unreadable native state item is equivalent to no
    // usable saved session in the desktop UX. Let the user sign in normally;
    // do not strand the app behind a recovery screen or repeat the prompt.
    return null;
  }
}

export async function saveAuthSession(session, storage) {
  if (!isStoredSession(session)) {
    throw localizedError(englishMessage("error.auth.validSessionRequired"), "error.auth.validSessionRequired");
  }
  if (!storage?.writeToken) {
    throw localizedError(englishMessage("error.auth.secureStorageUnavailable"), "error.auth.secureStorageUnavailable");
  }
  try {
    await storage.writeToken(session.accessToken, session.expiresAt);
  } catch (error) {
    throw annotateError(error, "error.auth.secureSessionWriteFailed");
  }
  return session;
}

export async function clearAuthSession(session, storage) {
  if (!storage?.clearToken) return;
  try {
    await storage.clearToken();
  } catch (error) {
    throw annotateError(error, "error.auth.secureSessionClearFailed");
  }
}

export async function revokeAuthSession(
  registryUrl,
  accessToken,
  fetchImpl = fetch,
  { timeoutMs = 1_500 } = {}
) {
  if (!accessToken) return;
  const controller = new AbortController();
  let timeoutId;
  try {
    const request = Promise.resolve().then(() => fetchImpl(
      new URL("/v1/auth/logout", registryUrl).toString(),
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        signal: controller.signal
      }
    )).catch(() => undefined);
    await Promise.race([
      request,
      new Promise((resolve) => {
        timeoutId = setTimeout(resolve, Math.max(1, timeoutMs));
      })
    ]);
  } catch {
    // Local sign-out still completes when the service is offline.
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
  }
}

export function startAuthSessionSignOut(
  registryUrl,
  session,
  storage,
  fetchImpl = fetch,
  options = {}
) {
  // Start the bounded server revoke first, but never make local state cleanup
  // deletion wait for a slow or offline network.
  const serverRevoke = revokeAuthSession(registryUrl, session?.accessToken, fetchImpl, options);
  const localClear = clearAuthSession(session, storage);
  return { serverRevoke, localClear };
}

export function createTauriAuthStorage(invokeImpl, { strict = false } = {}) {
  let fallbackToken = null;
  return {
    async readToken() {
      try {
        const token = await invokeImpl("read_auth_token");
        fallbackToken = typeof token === "string" && token.trim() ? token.trim() : null;
      } catch (error) {
        // Web-only renderer tests and Vite preview have no native state bridge.
        if (strict) throw annotateError(error, "error.auth.secureSessionReadFailed");
      }
      return fallbackToken;
    },
    async writeToken(token, expiresAt) {
      try {
        await invokeImpl("write_auth_token", { token, expiresAt: expiresAt || null });
        fallbackToken = token;
      } catch (error) {
        // Keep the in-memory fallback for the current renderer lifetime.
        if (strict) throw annotateError(error, "error.auth.secureSessionWriteFailed");
        fallbackToken = token;
      }
    },
    async clearToken() {
      try {
        await invokeImpl("clear_auth_token");
        fallbackToken = null;
      } catch (error) {
        // Clearing the in-memory value is sufficient when no native bridge exists.
        if (strict) throw annotateError(error, "error.auth.secureSessionClearFailed");
        fallbackToken = null;
      }
    }
  };
}

export function hydrateAuthSession(session, account) {
  if (!isStoredSession(session)) {
    throw localizedError(englishMessage("error.auth.validSessionRequired"), "error.auth.validSessionRequired");
  }
  if (!account?.id || !account?.display_name || !["user", "creator"].includes(account.role)) {
    throw localizedError(englishMessage("error.auth.invalidAccount"), "error.auth.invalidAccount");
  }
  return makeSessionFromAccount(account, session.accessToken, session.expiresAt || account.session_expires_at);
}

export function isStoredSession(value) {
  return Boolean(value?.accessToken);
}

export function isNetworkError(error) {
  return error?.code === "network_error";
}

export function isAuthInvalidError(error) {
  return error?.code === "auth_invalid" || error?.status === 401;
}

export function isRemoteAuthSessionCleared(payload, sourceWindow) {
  const eventSource = String(payload?.sourceWindow || "").trim();
  const currentWindow = String(sourceWindow || "").trim();
  return payload?.kind === "cleared"
    && Boolean(eventSource)
    && eventSource !== currentWindow;
}

function makeSessionFromAccount(account, accessToken, expiresAt) {
  return makeSession({
    id: account.id,
    name: account.display_name,
    role: account.role,
    accessToken,
    expiresAt
  });
}

function makeSession({ id, name, role, accessToken, expiresAt }) {
  return Object.freeze({
    ...(id && name && role ? { profile: Object.freeze({ id, name, role, initials: initials(name) }) } : {}),
    accessToken,
    ...(expiresAt ? { expiresAt } : {})
  });
}

function clientError(message, code, cause = null, status, i18nKey, i18nValues) {
  const error = localizedError(message, i18nKey, i18nValues);
  error.code = code;
  if (status) error.status = status;
  if (cause) error.cause = cause;
  return error;
}

function localizedError(message, i18nKey, i18nValues) {
  return annotateError(new Error(message), i18nKey, i18nValues);
}

function annotateError(error, i18nKey, i18nValues) {
  if (!error || typeof error !== "object") return error;
  error.i18nKey = i18nKey;
  if (i18nValues) error.i18nValues = i18nValues;
  return error;
}

function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("") || "U";
}
