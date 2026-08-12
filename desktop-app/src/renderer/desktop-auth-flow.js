import {
  fetchAuthAccount,
  hydrateAuthSession,
  saveAuthSession,
  signInAuthSession
} from "./auth-session.js";
import { fetchPurchasedCreatorAgents } from "./entitlement-client.js";
import { englishMessage } from "./i18n.js";

export const CONSUMER_DESKTOP_ROLE_MESSAGE =
  englishMessage("error.auth.unsupportedCreatorRole");
export const CONSUMER_DESKTOP_ROLE_MESSAGE_KEY = "error.auth.unsupportedCreatorRole";

export async function resolveDesktopSession(savedSession, registryUrl, fetchImpl = fetch) {
  const account = await fetchAuthAccount(registryUrl, savedSession.accessToken, fetchImpl);
  const session = hydrateAuthSession(savedSession, account);
  if (account.role !== "user") {
    return Object.freeze({
      state: "unsupported-role",
      session,
      entitlements: [],
      messageKey: CONSUMER_DESKTOP_ROLE_MESSAGE_KEY
    });
  }
  const entitlements = await fetchPurchasedCreatorAgents(registryUrl, session.accessToken, fetchImpl);
  return Object.freeze({ state: "ready", session, entitlements });
}

export async function signInDesktopSession(credentials, registryUrl, storage, fetchImpl = fetch) {
  const signedInSession = await signInAuthSession(credentials, registryUrl, fetchImpl);
  // Persist immediately after authentication. Registry identity/access checks can
  // then be retried from the launch recovery screen without asking for the
  // password again or discarding a valid opaque session on network/5xx errors.
  await saveAuthSession(signedInSession, storage);
  try {
    return await resolveDesktopSession(signedInSession, registryUrl, fetchImpl);
  } catch (error) {
    if (error && typeof error === "object") error.persistedDesktopSession = signedInSession;
    throw error;
  }
}

export function persistedDesktopSessionFromError(error) {
  return error?.persistedDesktopSession ?? null;
}
