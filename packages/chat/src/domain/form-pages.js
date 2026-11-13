const HATCH_DOMAIN = "gethatchapp.com";
const FORM_PATH = /^\/form\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_IN_TEXT = /https?:\/\/[^\s)\]>"'<]+/g;

/** "form" for an agent-written form page, "hatch" for any other page of this product, else "other". */
export function linkKind(href, origin = "") {
  let url;
  try { url = new URL(href, origin || undefined); } catch { return "other"; }
  if (!/^https?:$/.test(url.protocol)) return "other";
  const hatch = url.origin === origin || url.hostname === HATCH_DOMAIN || url.hostname.endsWith(`.${HATCH_DOMAIN}`);
  if (!hatch) return "other";
  return FORM_PATH.test(url.pathname) ? "form" : "hatch";
}

const textOf = ({ content, timeline }) => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter(block => block?.type === "text").map(block => block.text).join("\n")
  : timeline?.filter(entry => entry.kind === "text").map(entry => entry.content).join("\n") ?? "";

/** The form page link of the latest message only; older messages never count. */
export function latestFormLink(messages, origin = "") {
  const latest = messages.at(-1);
  if (!latest) return null;
  const url = (textOf(latest).match(URL_IN_TEXT) ?? []).find(candidate => linkKind(candidate, origin) === "form");
  return url ? { key: `${latest.renderKey ?? `${latest.run_id}-${latest.role}`}|${url}`, url } : null;
}
