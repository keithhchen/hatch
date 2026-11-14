/** { slug } for /help (slug null) and /help/<slug>; null for any other path. */
export function parseHelpRoute(pathname) {
  const match = pathname.match(/^\/help(?:\/([^/]+))?\/?$/);
  return match ? { slug: match[1] ? decodeURIComponent(match[1]) : null } : null;
}
