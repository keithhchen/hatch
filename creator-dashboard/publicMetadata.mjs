const DEFAULT_TITLE = "Hatch Creator Agents";
const DEFAULT_DESCRIPTION = "Discover Creator Agents you can use with Hatch Desktop.";

/**
 * Builds the client-safe metadata model for a canonical public product route.
 * A BFF can call this before returning the SPA shell; no product text is ever
 * interpolated without HTML escaping.
 */
export function createProductMetadata(input = {}) {
  const origin = safeOrigin(input.origin);
  const creatorSlug = requiredSegment(input.creatorSlug, "creatorSlug");
  const productSlug = requiredSegment(input.productSlug, "productSlug");
  const productName = cleanText(input.productName, "Creator Agent", 120);
  const creatorName = cleanText(input.creatorName, "Hatch Creator", 120);
  const description = cleanText(input.description, DEFAULT_DESCRIPTION, 300);
  const canonicalUrl = new URL(
    `/agents/${encodeURIComponent(creatorSlug)}/${encodeURIComponent(productSlug)}`,
    origin
  ).toString();
  const imageUrl = optionalPublicUrl(input.imageUrl, origin);

  return Object.freeze({
    title: `${productName} by ${creatorName} · Hatch`,
    description,
    canonicalUrl,
    ...(imageUrl ? { imageUrl } : {})
  });
}

/** Returns a complete, escaped metadata block suitable for insertion in head. */
export function renderProductMetadataTags(metadata) {
  const safe = normalizeMetadata(metadata);
  const title = escapeHtml(safe.title);
  const description = escapeAttribute(safe.description);
  const canonicalUrl = escapeAttribute(safe.canonicalUrl);
  const image = safe.imageUrl
    ? `\n    <meta property="og:image" content="${escapeAttribute(safe.imageUrl)}" />`
    : "";

  return `<meta data-hatch-product-metadata="start" />
    <meta name="description" content="${description}" />
    <link rel="canonical" href="${canonicalUrl}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Hatch" />
    <meta property="og:title" content="${escapeAttribute(safe.title)}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${canonicalUrl}" />${image}
    <meta name="twitter:card" content="${safe.imageUrl ? "summary_large_image" : "summary"}" />
    <meta name="twitter:title" content="${escapeAttribute(safe.title)}" />
    <meta name="twitter:description" content="${description}" />
    <meta data-hatch-product-metadata="end" />
    <title>${title}</title>`;
}

/**
 * Replaces the generic title in an SPA document with server-rendered product
 * metadata. The marker makes repeated rendering deterministic during retries.
 */
export function injectProductMetadata(documentHtml, metadata) {
  if (typeof documentHtml !== "string" || !/<head(?:\s[^>]*)?>/i.test(documentHtml)) {
    throw new TypeError("A complete HTML document with a head element is required");
  }
  const withoutPriorBlock = documentHtml.replace(
    /\s*<meta data-hatch-product-metadata="start"\s*\/>[\s\S]*?<meta data-hatch-product-metadata="end"\s*\/>\s*/gi,
    "\n"
  );
  const tags = renderProductMetadataTags(metadata);
  if (/<title(?:\s[^>]*)?>[\s\S]*?<\/title>/i.test(withoutPriorBlock)) {
    return withoutPriorBlock.replace(/<title(?:\s[^>]*)?>[\s\S]*?<\/title>/i, tags);
  }
  return withoutPriorBlock.replace(/<\/head>/i, `    ${tags}\n  </head>`);
}

/** Generic metadata for catalog/auth routes when no product is resolved. */
export function createDefaultMetadata(origin) {
  const canonicalUrl = new URL("/agents", safeOrigin(origin)).toString();
  return Object.freeze({
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    canonicalUrl
  });
}

export function createUnavailableProductMetadata(origin, creatorSlug, productSlug) {
  const safe = safeOrigin(origin);
  const canonicalUrl = new URL(
    `/agents/${encodeURIComponent(requiredSegment(creatorSlug, "creatorSlug"))}/${encodeURIComponent(requiredSegment(productSlug, "productSlug"))}`,
    safe
  ).toString();
  return Object.freeze({
    title: "Agent unavailable · Hatch",
    description: "This Creator Agent is unavailable or has been withdrawn.",
    canonicalUrl
  });
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object") throw new TypeError("metadata is required");
  const canonical = new URL(String(value.canonicalUrl));
  if (!isHttpProtocol(canonical.protocol) || canonical.username || canonical.password) {
    throw new TypeError("canonicalUrl must be an HTTP(S) URL without credentials");
  }
  const imageUrl = value.imageUrl ? optionalPublicUrl(value.imageUrl, canonical.origin) : undefined;
  return {
    title: cleanText(value.title, DEFAULT_TITLE, 180),
    description: cleanText(value.description, DEFAULT_DESCRIPTION, 300),
    canonicalUrl: canonical.toString(),
    ...(imageUrl ? { imageUrl } : {})
  };
}

function safeOrigin(value) {
  const parsed = new URL(String(value ?? ""));
  if (!isHttpProtocol(parsed.protocol) || parsed.username || parsed.password) {
    throw new TypeError("origin must be an HTTP(S) URL without credentials");
  }
  return parsed.origin;
}

function optionalPublicUrl(value, origin) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = new URL(String(value), origin);
  if (!isHttpProtocol(parsed.protocol) || parsed.username || parsed.password) {
    throw new TypeError("imageUrl must be an HTTP(S) URL without credentials");
  }
  return parsed.toString();
}

function requiredSegment(value, name) {
  const text = cleanText(value, "", 160);
  if (!text || /[\u0000-\u001f]/.test(text)) throw new TypeError(`${name} is required`);
  return text;
}

function cleanText(value, fallback, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, maxLength);
}

function isHttpProtocol(protocol) {
  return protocol === "https:" || protocol === "http:";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
