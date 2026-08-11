export async function signInAuthSession({ email, password }, registryUrl, fetchImpl = fetch) {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  const normalizedPassword = String(password ?? "");
  if (!normalizedEmail) throw new Error("Enter your email.");
  if (!normalizedPassword) throw new Error("Enter your password.");

  let response;
  try {
    response = await fetchImpl(new URL("/v1/auth/signin", registryUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email: normalizedEmail, password: normalizedPassword })
    });
  } catch (error) {
    throw clientError("Hatch can't reach the service. Check your connection and try again.", "network_error", error);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.detail || "Email or password is incorrect.");
    error.code = response.status === 401 ? "invalid_credentials" : "auth_request_failed";
    error.status = response.status;
    throw error;
  }
  const token = payload?.session?.token || payload?.token;
  if (!payload?.account?.role || !payload?.account?.id || !token) {
    throw clientError("The Registry returned an invalid account.", "auth_request_failed");
  }
  return makeSessionFromAccount(payload.account, token, payload.session?.expires_at);
}

export async function fetchAuthAccount(registryUrl, accessToken, fetchImpl = fetch) {
  if (!accessToken) throw clientError("A valid account session is required.", "auth_invalid", null, 401);
  let response;
  try {
    response = await fetchImpl(new URL("/v1/auth/me", registryUrl).toString(), {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
    });
  } catch (error) {
    throw clientError("Hatch can't reach the service. Check your connection and try again.", "network_error", error);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = response.status === 401 ? "auth_invalid" : "auth_request_failed";
    throw clientError(payload?.detail || "We couldn't verify this account session.", code, null, response.status);
  }
  if (!payload?.id || !payload?.role || !["user", "creator"].includes(payload.role)) {
    throw clientError("The Registry returned an invalid account.", "auth_request_failed");
  }
  return payload;
}

export async function loadSavedAuthSession(storage) {
  if (!storage?.readToken) return null;
  try {
    const accessToken = await storage.readToken();
    return accessToken ? Object.freeze({ accessToken }) : null;
  } catch {
    // A missing, locked, or unreadable Keychain item is indistinguishable from
    // no saved session in the desktop UX. Let the user sign in normally.
    return null;
  }
}

export async function saveAuthSession(session, storage) {
  if (!isStoredSession(session)) throw new Error("A valid session is required.");
  if (!storage?.writeToken) throw new Error("Secure session storage is unavailable.");
  await storage.writeToken(session.accessToken);
  return session;
}

export async function clearAuthSession(session, storage) {
  if (!storage?.clearToken) return;
  await storage.clearToken();
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
  // Start the bounded server revoke first, but never make local Keychain
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
        // Web-only renderer tests and Vite preview have no native Keychain.
        if (strict) throw error;
      }
      return fallbackToken;
    },
    async writeToken(token) {
      try {
        await invokeImpl("write_auth_token", { token });
        fallbackToken = token;
      } catch (error) {
        // Keep the in-memory fallback for the current renderer lifetime.
        if (strict) throw error;
        fallbackToken = token;
      }
    },
    async clearToken() {
      try {
        await invokeImpl("clear_auth_token");
        fallbackToken = null;
      } catch (error) {
        // Clearing the in-memory value is sufficient when no native bridge exists.
        if (strict) throw error;
        fallbackToken = null;
      }
    }
  };
}

export function hydrateAuthSession(session, account) {
  if (!isStoredSession(session)) throw new Error("A valid session is required.");
  if (!account?.id || !account?.display_name || !["user", "creator"].includes(account.role)) {
    throw new Error("The Registry returned an invalid account.");
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

function clientError(message, code, cause = null, status) {
  const error = new Error(message);
  error.code = code;
  if (status) error.status = status;
  if (cause) error.cause = cause;
  return error;
}

function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("") || "U";
}
