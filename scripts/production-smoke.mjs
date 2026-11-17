import { pathToFileURL } from "node:url";

export async function runProductionSmoke(options = {}) {
  const origin = requiredUrl(options.origin ?? process.env.HATCH_SMOKE_ORIGIN, "HATCH_SMOKE_ORIGIN");
  const creatorId = options.creatorId ?? process.env.HATCH_SMOKE_CREATOR_ID ?? "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21";
  const productId = options.productId ?? process.env.HATCH_SMOKE_PRODUCT_ID ?? "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42";
  const email = options.email ?? process.env.HATCH_SMOKE_EMAIL;
  const password = options.password ?? process.env.HATCH_SMOKE_PASSWORD;
  const fetchImpl = options.fetchImpl ?? fetch;
  const canonicalPath = `/products/${encodeURIComponent(productId)}`;

  const publicPage = await smokeRequest(fetchImpl, origin, canonicalPath);
  assertStatus(publicPage, 200, "canonical product page");
  assertIncludes(publicPage.text, `<link rel="canonical" href="${new URL(canonicalPath, origin).href}"`, "canonical metadata");

  const productResponse = await smokeRequest(
    fetchImpl,
    origin,
    `/v1/public/products/${encodeURIComponent(productId)}`
  );
  assertStatus(productResponse, 200, "public product API");
  const product = productResponse.json?.product ?? productResponse.json?.agent ?? productResponse.json;
  if (!product?.available || product.availability !== "published") {
    throw new Error("Access smoke requires a published Product.");
  }
  if (!email && !password) {
    return { mode: "public", creator_id: creatorId, product_id: productId };
  }
  if (!email || !password) throw new Error("HATCH_SMOKE_EMAIL and HATCH_SMOKE_PASSWORD must be configured together.");
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
  if (!me.json?.id || me.json.id === creatorId) throw new Error("Smoke account must be signed in and must not own the smoke Product.");

  // Open access: a signed-in account can read its library (the Agents it has chatted with).
  const library = await smokeRequest(fetchImpl, origin, "/v1/library?status=active", { headers: { cookie } });
  assertStatus(library, 200, "library listing");
  if (!Array.isArray(library.json?.entitlements)) throw new Error("Library listing did not return an entitlements list.");
  const download = await smokeRequest(fetchImpl, origin, "/download");
  assertStatus(download, 200, "Desktop download route");
  return { mode: "authenticated", creator_id: creatorId, product_id: productId };
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

function assertStatus(result, expected, label) {
  if (result.status !== expected) throw smokeError(label, result);
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
  runProductionSmoke()
    .then((result) => console.log(`Production ${result.mode} smoke passed for ${result.creator_id}/${result.product_id}.`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Production smoke failed.");
      process.exitCode = 1;
    });
}
