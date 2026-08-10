export function canUseAnotherAccountFromNetworkError(session) {
  return Boolean(session?.accessToken);
}
