const DEFAULT_TITLE = "Hatch Creator Agents";
const DEFAULT_DESCRIPTION = "Discover Creator Agents you can use with Hatch Desktop.";

/**
 * Builds the client-safe metadata model for a canonical public product route.
 * A BFF can call this before returning the SPA shell; no product text is ever
 * interpolated without HTML escaping.
 */
export function createProductMetadata(input = {}) {
  const origin = safeOrigin(input.origin);
  const creatorId = requiredUuid(input.creatorId, "creatorId");
  const productId = requiredUuid(input.productId, "productId");
  const productName = cleanText(input.productName, "Creator Agent", 120);
  const creatorName = cleanText(input.creatorName, "Hatch Creator", 120);
  const description = cleanText(input.description, DEFAULT_DESCRIPTION, 300);
  const routePrefix = String(input.routePrefix ?? "/products").replace(/\/+$/, "") || "/products";
  const canonicalUrl = new URL(
    `${routePrefix}/${encodeURIComponent(productId)}`,
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
export function createDefaultMetadata(origin, routePrefix = "/explore") {
  const canonicalUrl = new URL(String(routePrefix || "/explore"), safeOrigin(origin)).toString();
  return Object.freeze({
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    canonicalUrl
  });
}

export function createUnavailableProductMetadata(origin, productId, _unused = undefined, routePrefix = "/products") {
  const safe = safeOrigin(origin);
  const canonicalUrl = new URL(
    `${String(routePrefix || "/products").replace(/\/+$/, "")}/${encodeURIComponent(requiredUuid(productId, "productId"))}`,
    safe
  ).toString();
  return Object.freeze({
    title: "Agent unavailable · Hatch",
    description: "This Creator Agent is unavailable or has been withdrawn.",
    canonicalUrl
  });
}

/**
 * Minimal no-JavaScript body for a shared Product URL. The normal page is
 * still hydrated by the Dashboard SPA, but a crawler, text browser, or a
 * user with scripts disabled should see the product promise and the same
 * free-claim entry point instead of an empty root div.
 */
export function createProductNoScriptFallback(input = {}) {
  const productId = requiredUuid(input.productId, "productId");
  const creatorId = requiredUuid(input.creatorId, "creatorId");
  const productName = cleanText(input.productName, "Creator Agent", 120);
  const creatorName = cleanText(input.creatorName, "Hatch Creator", 120);
  const description = cleanText(input.description, DEFAULT_DESCRIPTION, 300);
  const productPath = `/products/${productId}`;
  const creatorPath = `/creators/${creatorId}`;
  const amountMinor = Number(input.amountMinor);
  const isFree = Number.isSafeInteger(amountMinor) && amountMinor === 0;
  const action = isFree
    ? `<a href="/sign-in?returnTo=${escapeAttribute(encodeURIComponent(productPath))}">Get for free</a>`
    : `<span>Not available yet</span>`;
  return `<noscript data-hatch-product-fallback="true"><main><p><a href="${creatorPath}">${escapeHtml(creatorName)}</a></p><h1>${escapeHtml(productName)}</h1><p>${escapeHtml(description)}</p><p>${action}</p></main></noscript>`;
}

/** Insert the no-script fragment once, without disturbing the SPA shell. */
export function injectProductNoScriptFallback(documentHtml, fallback) {
  if (typeof documentHtml !== "string" || !/<body(?:\s[^>]*)?>/i.test(documentHtml)) {
    throw new TypeError("A complete HTML document with a body element is required");
  }
  if (typeof fallback !== "string" || !fallback) return documentHtml;
  const withoutPrior = documentHtml.replace(
    /\s*<noscript data-hatch-product-fallback="true">[\s\S]*?<\/noscript>\s*/gi,
    "\n"
  );
  return withoutPrior.replace(/<body(?:\s[^>]*)?>/i, (match) => `${match}\n    ${fallback}`);
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

function requiredUuid(value, name) {
  const text = requiredSegment(value, name).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) {
    throw new TypeError(`${name} must be a UUID v4`);
  }
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
