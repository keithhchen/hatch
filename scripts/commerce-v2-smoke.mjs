import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export async function runCommerceV2Smoke(options = {}) {
  const origin = requiredUrl(options.origin ?? process.env.HATCH_SMOKE_ORIGIN, "HATCH_SMOKE_ORIGIN");
  const creatorId = options.creatorId ?? process.env.HATCH_SMOKE_CREATOR_ID ?? "maya-chen";
  const productId = options.productId ?? process.env.HATCH_SMOKE_PRODUCT_ID ?? "signal-resume-review";
  const email = options.email ?? process.env.HATCH_SMOKE_EMAIL;
  const password = options.password ?? process.env.HATCH_SMOKE_PASSWORD;
  const fetchImpl = options.fetchImpl ?? fetch;
  const canonicalPath = `/agents/${encodeURIComponent(creatorId)}/${encodeURIComponent(productId)}`;

  const publicPage = await smokeRequest(fetchImpl, origin, canonicalPath);
  assertStatus(publicPage, 200, "canonical product page");
  assertIncludes(publicPage.text, `<link rel="canonical" href="${new URL(canonicalPath, origin).href}"`, "canonical metadata");

  const productResponse = await smokeRequest(
    fetchImpl,
    origin,
    `/v1/catalog/agents/${encodeURIComponent(creatorId)}/${encodeURIComponent(productId)}`
  );
  assertStatus(productResponse, 200, "public product API");
  const product = productResponse.json?.agent ?? productResponse.json;
  if (!product?.available || product.availability !== "published") {
    throw new Error("Commerce smoke requires a published product with an active Commerce offer.");
  }
  if (!product.offer?.offer_id || !Number.isSafeInteger(Number(product.offer.revision))) {
    throw new Error("Commerce smoke product is missing a versioned offer snapshot.");
  }
  if (!product.release_id || !product.corpus_digest) {
    throw new Error("Commerce smoke product is missing an immutable release binding.");
  }
  if (!email && !password) {
    return { mode: "public", creator_id: creatorId, product_id: productId, offer_id: product.offer.offer_id };
  }
  if (!email || !password) throw new Error("HATCH_SMOKE_EMAIL and HATCH_SMOKE_PASSWORD must be configured together.");
  if (Number(product.offer.amount_minor) !== 0) {
    throw new Error("Authenticated production smoke only confirms a zero-value offer; use provider sandbox for paid capture.");
  }

  const login = await smokeRequest(fetchImpl, origin, "/v1/auth/login", {
    method: "POST",
    headers: sameOriginHeaders(origin),
    body: { email, password }
  });
  assertStatus(login, 200, "UAT sign in");
  if (login.json?.token) throw new Error("Browser login exposed a Registry bearer token.");
  const cookies = responseCookies(login.response);
  const sessionCookie = cookieValue(cookies, "hatch_web_session");
  const csrfCookie = cookieValue(cookies, "hatch_web_csrf");
  if (!sessionCookie || !csrfCookie) throw new Error("Browser login did not issue the Web session and CSRF cookies.");
  assertWebCookiePolicy(cookies, { secure: new URL(origin).protocol === "https:" });
  const cookie = cookies.map((value) => value.split(";", 1)[0]).join("; ");
  const authenticatedHeaders = { ...sameOriginHeaders(origin), cookie, "x-csrf-token": csrfCookie };

  const me = await smokeRequest(fetchImpl, origin, "/v1/auth/me", { headers: { cookie } });
  assertStatus(me, 200, "authenticated profile");
  if (me.json?.role !== "user") throw new Error("Commerce smoke account must have the Buyer user role.");

  // Application redeploys must replay the same smoke purchase. A new order is
  // justified only when the immutable product release or active offer changes.
  const intentKey = smokeIntentKey({ creatorId, productId, product });
  const checkout = await smokeRequest(fetchImpl, origin, "/v1/checkout-sessions", {
    method: "POST",
    headers: { ...authenticatedHeaders, "idempotency-key": `${intentKey}:create` },
    body: { creator_id: creatorId, product_id: productId, offer_id: product.offer.offer_id }
  });
  assertOneOf(checkout, [200, 201], "checkout session");
  const session = checkout.json?.checkout_session;
  if (!session?.checkout_session_id || Number(session.totals?.total_minor) !== 0) {
    throw new Error("Commerce smoke checkout is not a durable zero-value session.");
  }

  const confirmation = await smokeRequest(
    fetchImpl,
    origin,
    `/v1/checkout-sessions/${encodeURIComponent(session.checkout_session_id)}/confirm`,
    {
      method: "POST",
      headers: { ...authenticatedHeaders, "idempotency-key": `${intentKey}:confirm` },
      body: {}
    }
  );
  assertOneOf(confirmation, [200, 201], "checkout confirmation");
  const orderId = confirmation.json?.order_id ?? confirmation.json?.order?.order_id;
  const entitlementId = confirmation.json?.entitlement_id ?? confirmation.json?.entitlement?.entitlement_id;
  if (!orderId || !entitlementId) throw new Error("Commerce smoke confirmation did not return an order and entitlement.");
  if (confirmation.json?.payment?.status !== "not_required") {
    throw new Error("Zero-value Commerce smoke must record Payment Not required.");
  }

  const order = await smokeRequest(fetchImpl, origin, `/v1/user/orders/${encodeURIComponent(orderId)}`, {
    headers: { cookie }
  });
  assertStatus(order, 200, "durable order detail");
  const receipt = order.json?.order ?? order.json;
  if (receipt.offer_id !== product.offer.offer_id
    || Number(receipt.offer_revision) !== Number(product.offer.revision)
    || receipt.release_id !== product.release_id
    || receipt.corpus_digest !== product.corpus_digest) {
    throw new Error("Order detail did not preserve the public offer snapshot.");
  }
  if (Number(receipt.gross_minor) !== 0
    || Number(receipt.subtotal_minor) !== 0
    || Number(receipt.discount_minor) !== 0
    || receipt.tax_minor !== null
    || Number(receipt.total_minor) !== 0
    || receipt.payment_status !== "not_required"
    || receipt.payment_id !== null
    || receipt.currency !== product.offer.currency) {
    throw new Error("Order detail did not preserve zero-value Payment Not required semantics.");
  }
  const entitlement = await smokeRequest(fetchImpl, origin, `/v1/user/entitlements/${encodeURIComponent(entitlementId)}`, {
    headers: { cookie }
  });
  assertStatus(entitlement, 200, "durable entitlement detail");
  const access = entitlement.json?.entitlement ?? entitlement.json;
  if (access.entitlement_id !== entitlementId || access.order_id !== orderId) {
    throw new Error("Entitlement detail is not bound to the confirmed order.");
  }
  if (access.creator_id !== creatorId
    || access.product_id !== productId
    || access.purchased_corpus_digest !== product.corpus_digest
    || access.effective_corpus_digest !== product.corpus_digest
    || access.status !== "active"
    || Number(access.remaining_units) < 1) {
    throw new Error("Entitlement detail did not preserve active release-pinned access.");
  }

  const success = await smokeRequest(fetchImpl, origin, `/portal/orders/${encodeURIComponent(orderId)}/success`, {
    headers: { cookie }
  });
  assertStatus(success, 200, "durable success route");
  const download = await smokeRequest(fetchImpl, origin, "/download");
  assertStatus(download, 200, "Desktop download route");
  return { mode: "authenticated", creator_id: creatorId, product_id: productId, order_id: orderId, entitlement_id: entitlementId };
}

function sameOriginHeaders(origin) {
  return { origin: new URL(origin).origin, "sec-fetch-site": "same-origin" };
}

async function smokeRequest(fetchImpl, origin, pathname, options = {}) {
  const headers = { accept: "application/json, text/html", ...(options.headers ?? {}) };
  const response = await fetchImpl(new URL(pathname, origin), {
    method: options.method ?? "GET",
    headers: options.body === undefined ? headers : { ...headers, "content-type": "application/json" },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(15_000)
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { response, status: response.status, text, json };
}

function responseCookies(response) {
  if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie();
  const combined = response.headers.get("set-cookie");
  return combined ? combined.split(/,(?=\s*[^;,=]+=[^;,]+)/).map((value) => value.trim()) : [];
}

function cookieValue(cookies, name) {
  const prefix = `${name}=`;
  const pair = cookies.find((value) => value.startsWith(prefix))?.split(";", 1)[0];
  return pair ? decodeURIComponent(pair.slice(prefix.length)) : undefined;
}

function assertWebCookiePolicy(cookies, { secure }) {
  const session = cookies.find((value) => value.startsWith("hatch_web_session="));
  const csrf = cookies.find((value) => value.startsWith("hatch_web_csrf="));
  if (!session || !csrf) throw new Error("Browser login did not issue both Web cookies.");
  for (const value of [session, csrf]) {
    if (!/;\s*Path=\//i.test(value) || !/;\s*SameSite=Lax/i.test(value)) {
      throw new Error("Browser login cookies must use Path=/ and SameSite=Lax.");
    }
    if (secure && !/;\s*Secure(?:;|$)/i.test(value)) {
      throw new Error("HTTPS Browser login cookies must use Secure.");
    }
  }
  if (!/;\s*HttpOnly(?:;|$)/i.test(session) || /;\s*HttpOnly(?:;|$)/i.test(csrf)) {
    throw new Error("Browser session must be HttpOnly while the CSRF cookie remains browser-readable.");
  }
}

function smokeIntentKey({ creatorId, productId, product }) {
  const digest = createHash("sha256").update(JSON.stringify({
    creator_id: creatorId,
    product_id: productId,
    release_id: product.release_id,
    corpus_digest: product.corpus_digest,
    offer_id: product.offer.offer_id,
    offer_revision: Number(product.offer.revision)
  })).digest("hex");
  return `production-smoke:${digest}`;
}

function assertStatus(result, expected, label) {
  if (result.status !== expected) throw smokeError(label, result);
}

function assertOneOf(result, expected, label) {
  if (!expected.includes(result.status)) throw smokeError(label, result);
}

function smokeError(label, result) {
  const code = result.json?.error?.code ?? "unexpected_response";
  return new Error(`${label} failed with HTTP ${result.status} (${code}).`);
}

function assertIncludes(value, expected, label) {
  if (!String(value).includes(expected)) throw new Error(`${label} is missing from the response.`);
}

function requiredUrl(value, name) {
  const url = new URL(String(value ?? ""));
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials.`);
  }
  return url.origin;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCommerceV2Smoke()
    .then((result) => console.log(`Commerce V2 ${result.mode} smoke passed for ${result.creator_id}/${result.product_id}.`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Commerce V2 smoke failed.");
      process.exitCode = 1;
    });
}
