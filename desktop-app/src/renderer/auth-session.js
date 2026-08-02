const ACTIVE_SESSION_KEY = "hatch.auth.activeProfile";
const SESSION_KEY_PREFIX = "hatch.auth.profile.";

export function configuredAuthSession(environment = import.meta.env) {
  const id = environment.VITE_HATCH_ACCOUNT_ID?.trim();
  const name = environment.VITE_HATCH_DISPLAY_NAME?.trim();
  const accessToken = environment.VITE_HATCH_AUTH_TOKEN?.trim();
  const role = environment.VITE_HATCH_ACCOUNT_ROLE?.trim();
  if (!id || !name || !accessToken || !["user", "creator"].includes(role)) return null;
  return makeSession({ id, name, role, accessToken });
}

export async function signInAuthSession({ email, password }, registryUrl, fetchImpl = fetch) {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  const normalizedPassword = String(password ?? "");
  if (!normalizedEmail) throw new Error("Enter your email.");
  if (!normalizedPassword) throw new Error("Enter your password.");
  const response = await fetchImpl(new URL("/v1/auth/signin", registryUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email: normalizedEmail, password: normalizedPassword })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.detail || "Email or password is incorrect.");
  if (!payload?.account?.role || !payload?.account?.id || !payload?.token) {
    throw new Error("The Registry returned an invalid account.");
  }
  return makeSession({
    id: payload.account.id,
    name: payload.account.display_name,
    role: payload.account.role,
    accessToken: payload.token
  });
}

export function loadSavedAuthSession(storage = globalThis.localStorage) {
  try {
    const profileId = storage?.getItem(ACTIVE_SESSION_KEY);
    if (!profileId) return null;
    const value = JSON.parse(storage.getItem(sessionStorageKey(profileId)) || "null");
    if (!isStoredSession(value) || value.profile.id !== profileId) return null;
    return makeSession({ id: value.profile.id, name: value.profile.name, role: value.profile.role, accessToken: value.accessToken });
  } catch {
    return null;
  }
}

export function saveAuthSession(session, storage = globalThis.localStorage) {
  if (!isStoredSession(session)) throw new Error("A valid session is required.");
  storage.setItem(sessionStorageKey(session.profile.id), JSON.stringify({
    profile: { id: session.profile.id, name: session.profile.name, role: session.profile.role },
    accessToken: session.accessToken
  }));
  storage.setItem(ACTIVE_SESSION_KEY, session.profile.id);
}

export async function validateAndSaveAuthSession(session, loadPurchasedAgents, storage = globalThis.localStorage) {
  if (!isStoredSession(session)) throw new Error("A valid session is required.");
  const agents = await loadPurchasedAgents(session.accessToken);
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error("No Creator Agents are available for this account yet.");
  }
  saveAuthSession(session, storage);
  return agents;
}

export function clearAuthSession(session, storage = globalThis.localStorage) {
  const profileId = session?.profile?.id;
  if (profileId) storage.removeItem(sessionStorageKey(profileId));
  if (!profileId || storage.getItem(ACTIVE_SESSION_KEY) === profileId) storage.removeItem(ACTIVE_SESSION_KEY);
}

export function sessionStorageKey(profileId) {
  return `${SESSION_KEY_PREFIX}${encodeURIComponent(profileId)}`;
}

function makeSession({ id, name, role, accessToken }) {
  return Object.freeze({
    profile: Object.freeze({ id, name, role, initials: initials(name) }),
    accessToken
  });
}

function isStoredSession(value) {
  return Boolean(value?.profile?.id && value?.profile?.name && ["user", "creator"].includes(value?.profile?.role) && value?.accessToken);
}

function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("") || "U";
}
