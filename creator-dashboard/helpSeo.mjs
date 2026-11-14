// Server-rendered head and body for the public Help pages, so a crawler that never runs JavaScript still sees
// the title, description, hreflang alternates, a VideoObject and the text. The SPA replaces the body once it loads.
import { HELP_ITEMS, HELP_LOCALES, HELP_PAGE_COPY as PAGE, helpGroups, helpItem, helpPath, localizeHelpItem } from "./helpCatalog.mjs";
import { injectProductMetadata } from "./publicMetadata.mjs";

export const HELP_ORIGIN = "https://gethatchapp.com";
const HTML_LANG = { en: "en", zh: "zh-CN", ja: "ja-JP" };
const HREFLANG = { en: "en", zh: "zh-CN", ja: "ja" };

const esc = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const absolute = (origin, value) => new URL(value, origin).toString();
export const helpLocale = value => (HELP_LOCALES.includes(value) ? value : "en");
/** Every language of a page plus x-default (English). */
const alternates = (origin, item) => [...HELP_LOCALES.map(lang => [HREFLANG[lang], absolute(origin, helpPath(item, lang))]), ["x-default", absolute(origin, helpPath(item))]];

function videoObject(origin, item, lang, mediaBase) {
  const v = localizeHelpItem(item, lang, mediaBase);
  return {
    "@context": "https://schema.org", "@type": "VideoObject", name: v.title, description: v.description,
    thumbnailUrl: absolute(origin, v.poster), uploadDate: v.published, duration: v.duration, inLanguage: HTML_LANG[lang],
    contentUrl: absolute(origin, v.src), embedUrl: absolute(origin, helpPath(item, lang))
  };
}

/** The page for /help or /help/<slug>: { status, lang, body, headExtras, metadata }, { status: 404 } for an unknown slug, or null when the path is not a Help route. */
export function helpPage(pathname, search = "", { origin = HELP_ORIGIN, mediaBase } = {}) {
  const match = pathname.match(/^\/help(?:\/([^/]+))?\/?$/);
  if (!match) return null;
  const lang = helpLocale(new URLSearchParams(search).get("lang"));
  const copy = PAGE[lang];
  const item = match[1] ? helpItem(decodeURIComponent(match[1])) : null;
  if (match[1] && !item) return { status: 404 };
  const v = item && localizeHelpItem(item, lang, mediaBase);
  const links = alternates(origin, item).map(([hreflang, href]) => `<link rel="alternate" hreflang="${hreflang}" href="${esc(href)}" />`).join("\n    ");
  const json = item?.kind === "video" ? `\n    <script type="application/ld+json">${JSON.stringify(videoObject(origin, item, lang, mediaBase)).replaceAll("<", "\\u003c")}</script>` : "";
  const listing = helpGroups(lang, mediaBase).map(group =>
    `<section><h2>${esc(copy[group.kind])}</h2><ul>${group.items.map(entry => `<li><a href="${esc(helpPath(entry, lang))}">${esc(entry.title)}</a><p>${esc(entry.description)}</p></li>`).join("")}</ul></section>`).join("");
  const body = `<main><p><a href="/">Hatch</a></p>${v
    ? `<h1>${esc(v.title)}</h1><p>${esc(v.description)}</p><p><a href="${esc(helpPath(null, lang))}">${esc(copy.index)}</a></p>`
    : `<h1>${esc(copy.index)}</h1>${listing}`}</main>`;
  return {
    status: 200, lang, body, headExtras: `${links}${json}`,
    metadata: { title: `${v ? v.title : copy.index} · Hatch`, description: v ? v.description : copy.description, canonicalUrl: absolute(origin, helpPath(item, lang)), ...(v?.poster ? { imageUrl: absolute(origin, v.poster) } : {}) }
  };
}

/** Puts a helpPage result into the SPA shell: metadata, hreflang, JSON-LD, the html lang and the static body. */
export function injectHelpPage(documentHtml, page) {
  return injectProductMetadata(documentHtml, page.metadata)
    .replace(/<\/head>/i, () => `    ${page.headExtras}\n  </head>`)
    .replace(/<html lang="[^"]*"/i, `<html lang="${HTML_LANG[page.lang]}"`)
    .replace('<div id="root"></div>', () => `<div id="root">${page.body}</div>`);
}

/** sitemap.xml: the landing page and every Help URL in every language, each with its hreflang alternates. */
export function sitemapXml(origin = HELP_ORIGIN, items = HELP_ITEMS) {
  const urls = [`<url><loc>${esc(origin)}/</loc></url>`];
  for (const item of [null, ...items]) {
    const alt = alternates(origin, item).map(([hreflang, href]) => `<xhtml:link rel="alternate" hreflang="${hreflang}" href="${esc(href)}"/>`).join("");
    for (const lang of HELP_LOCALES) urls.push(`<url><loc>${esc(absolute(origin, helpPath(item, lang)))}</loc>${alt}</url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
}

export const robotsTxt = (origin = HELP_ORIGIN) => `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;
