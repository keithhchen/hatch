// Server-rendered head and body for the public Help pages, so a crawler that never runs JavaScript still sees
// the title, description, a VideoObject and the text, in the language of its Accept-Language. The SPA replaces the body once it loads.
import { HELP_ITEMS, HELP_LOCALES, HELP_PAGE_COPY as PAGE, helpGroups, helpItem, helpPath, localizeHelpItem } from "./helpCatalog.mjs";
import { injectProductMetadata } from "./publicMetadata.mjs";

export const HELP_ORIGIN = "https://gethatchapp.com";
const HTML_LANG = { en: "en", zh: "zh-CN", ja: "ja-JP" };

const esc = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const absolute = (origin, value) => new URL(value, origin).toString();
/** The first supported language (zh, ja, en) in an Accept-Language header, by quality; English when none. */
export function acceptedLocale(header = "") {
  const ranked = String(header).split(",").map(part => {
    const [tag, ...params] = part.trim().split(";");
    const q = Number(params.find(p => p.trim().startsWith("q="))?.split("=")[1] ?? 1);
    return { locale: tag.trim().toLowerCase().slice(0, 2), q: Number.isFinite(q) ? q : 0 };
  }).filter(entry => entry.q > 0 && HELP_LOCALES.includes(entry.locale));
  return ranked.sort((a, b) => b.q - a.q)[0]?.locale ?? "en";
}

function videoObject(origin, item, lang, mediaBase) {
  const v = localizeHelpItem(item, lang, mediaBase);
  return {
    "@context": "https://schema.org", "@type": "VideoObject", name: v.title, description: `${v.description}${PAGE[lang].subtitled}`,
    thumbnailUrl: absolute(origin, v.poster), uploadDate: v.published, duration: v.duration, inLanguage: "en",
    contentUrl: absolute(origin, v.src), embedUrl: absolute(origin, helpPath(item))
  };
}

/** The page for /help or /help/<slug>: { status, lang, body, headExtras, metadata }, { status: 404 } for an unknown slug, or null when the path is not a Help route. */
export function helpPage(pathname, acceptLanguage, { origin = HELP_ORIGIN, mediaBase } = {}) {
  const match = pathname.match(/^\/help(?:\/([^/]+))?\/?$/);
  if (!match) return null;
  const lang = acceptedLocale(acceptLanguage);
  const copy = PAGE[lang];
  const item = match[1] ? helpItem(decodeURIComponent(match[1])) : null;
  if (match[1] && !item) return { status: 404 };
  const v = item && localizeHelpItem(item, lang, mediaBase);
  const json = item?.kind === "video" ? `\n    <script type="application/ld+json">${JSON.stringify(videoObject(origin, item, lang, mediaBase)).replaceAll("<", "\\u003c")}</script>` : "";
  const listing = helpGroups(lang, mediaBase).map(group =>
    `<section><h2>${esc(copy[group.kind])}</h2><ul>${group.items.map(entry => `<li><a href="${esc(helpPath(entry))}">${esc(entry.title)}</a><p>${esc(entry.description)}</p></li>`).join("")}</ul></section>`).join("");
  const body = `<main><p><a href="/">Hatch</a></p>${v
    ? `<h1>${esc(v.title)}</h1><p>${esc(v.description)}</p><p><a href="${esc(helpPath(null))}">${esc(copy.index)}</a></p>`
    : `<h1>${esc(copy.index)}</h1>${listing}`}</main>`;
  return {
    status: 200, lang, body, headExtras: json,
    metadata: { title: `${v ? v.title : copy.index} · Hatch`, description: v ? v.description : copy.description, canonicalUrl: absolute(origin, helpPath(item)), ...(v?.poster ? { imageUrl: absolute(origin, v.poster) } : {}) }
  };
}

/** Puts a helpPage result into the SPA shell: metadata, JSON-LD, the html lang and the static body. */
export function injectHelpPage(documentHtml, page) {
  return injectProductMetadata(documentHtml, page.metadata)
    .replace(/<\/head>/i, () => `    ${page.headExtras}\n  </head>`)
    .replace(/<html lang="[^"]*"/i, `<html lang="${HTML_LANG[page.lang]}"`)
    .replace('<div id="root"></div>', () => `<div id="root">${page.body}</div>`);
}

/** sitemap.xml: the landing page and one URL per Help page. */
export function sitemapXml(origin = HELP_ORIGIN, items = HELP_ITEMS) {
  const urls = [`<url><loc>${esc(origin)}/</loc></url>`, ...[null, ...items].map(item => `<url><loc>${esc(absolute(origin, helpPath(item)))}</loc></url>`)];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export const robotsTxt = (origin = HELP_ORIGIN) => `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;
