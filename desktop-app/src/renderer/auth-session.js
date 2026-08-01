const ACTIVE_SESSION_KEY = "hatch.auth.activeProfile";
const SESSION_KEY_PREFIX = "hatch.auth.profile.";

export function configuredAuthSession(environment = import.meta.env) {
  const id = environment.VITE_HATCH_USER_ID?.trim();
  const name = environment.VITE_HATCH_USER_NAME?.trim();
  const accessToken = environment.VITE_HATCH_ACCESS_TOKEN?.trim();
  if (!id || !name || !accessToken) return null;
  return makeSession({ id, name, accessToken });
}

export function accessCodeAuthSession({ name, accessCode }) {
  const normalizedName = String(name ?? "").trim().replace(/\s+/g, " ");
  const normalizedCode = String(accessCode ?? "").trim();
  if (!normalizedName) throw new Error("Enter your name.");
  if (!normalizedCode) throw new Error("Enter your access code.");
  return makeSession({
    id: `buyer_${stableHash(normalizedCode)}`,
    name: normalizedName,
    accessToken: normalizedCode
  });
}

export function loadSavedAuthSession(storage = globalThis.localStorage) {
  try {
    const profileId = storage?.getItem(ACTIVE_SESSION_KEY);
    if (!profileId) return null;
    const value = JSON.parse(storage.getItem(sessionStorageKey(profileId)) || "null");
    if (!isStoredSession(value) || value.profile.id !== profileId) return null;
    return makeSession({ id: value.profile.id, name: value.profile.name, accessToken: value.accessToken });
  } catch {
    return null;
  }
}

export function saveAuthSession(session, storage = globalThis.localStorage) {
  if (!isStoredSession(session)) throw new Error("A valid session is required.");
  storage.setItem(sessionStorageKey(session.profile.id), JSON.stringify({
    profile: { id: session.profile.id, name: session.profile.name },
    accessToken: session.accessToken
  }));
  storage.setItem(ACTIVE_SESSION_KEY, session.profile.id);
}

export async function validateAndSaveAuthSession(session, loadPurchasedAgents, storage = globalThis.localStorage) {
  if (!isStoredSession(session)) throw new Error("A valid session is required.");
  const agents = await loadPurchasedAgents(session.accessToken);
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error("We couldn't find any purchased agents for that access code.");
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

function makeSession({ id, name, accessToken }) {
  return Object.freeze({
    profile: Object.freeze({ id, name, initials: initials(name) }),
    accessToken
  });
}

function isStoredSession(value) {
  return Boolean(value?.profile?.id && value?.profile?.name && value?.accessToken);
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("") || "U";
}
