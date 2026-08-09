import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CommerceLedger,
  projectBuyerEntitlements,
  projectBuyerOrders,
  projectCreatorDashboard
} from "../packages/commerce/src/index.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export async function createDashboardApp(options = {}) {
  const ledgerPath = options.ledgerPath
    ?? process.env.HATCH_COMMERCE_LEDGER_PATH
    ?? path.join(currentDirectory, ".local-uat", "ledger.jsonl");
  const registryUrl = options.registryUrl
    ?? process.env.HATCH_REGISTRY_URL
    ?? "http://127.0.0.1:8100";
  const ledger = await CommerceLedger.open({ filePath: ledgerPath });
  const fetchImpl = options.fetchImpl ?? fetch;

  const handler = async (request, response) => {
    try {
      if (request.method === "OPTIONS") return send(response, 204, undefined);
      const url = new URL(request.url ?? "/", "http://dashboard.local");
      if (request.method === "GET" && url.pathname === "/healthz") {
        return send(response, 200, { ok: true });
      }
      if (request.method === "GET" && (url.pathname === "/portal" || url.pathname.startsWith("/portal/"))) {
        return servePortalAsset(url.pathname, response);
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/login") {
        const body = await readJson(request);
        const auth = await registryRequest(registryUrl, "/v1/auth/signin", {
          method: "POST",
          body: JSON.stringify({ email: body.email, password: body.password }),
          fetchImpl
        });
        return send(response, 200, { token: auth.token, profile: publicProfile(auth.account) });
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
        return send(response, 204, undefined);
      }
      if (request.method === "GET" && url.pathname === "/v1/auth/me") {
        const authentication = await authenticate(request, registryUrl, undefined, fetchImpl);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        return send(response, 200, authentication.profile);
      }

      if (request.method === "GET" && url.pathname === "/v1/catalog/agents") {
        return send(response, 200, await registryRequest(registryUrl, "/v1/catalog/agents", { fetchImpl }));
      }

      if (request.method === "GET" && url.pathname === "/v1/user/agents") {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const [access, catalog] = await Promise.all([
          registryRequest(registryUrl, "/v1/user/agent-access", {
            fetchImpl,
            headers: { authorization: `Bearer ${bearerToken(request)}` }
          }),
          registryRequest(registryUrl, "/v1/catalog/agents", { fetchImpl })
        ]);
        return send(response, 200, { creator_agents: mergeRegistryAgents(access, catalog) });
      }

      if (request.method === "GET" && url.pathname === "/v1/user/orders") {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        return send(response, 200, {
          orders: projectBuyerOrders(ledger.listEvents(), authentication.profile.id)
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/user/checkout") {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const body = await readJson(request);
        const creatorId = String(body.creator_id ?? "").trim();
        const productId = String(body.product_id ?? "").trim();
        if (!creatorId || !productId) {
          return send(response, 400, { error: { code: "invalid_checkout", message: "creator_id and product_id are required." } });
        }
        const catalog = await registryRequest(registryUrl, "/v1/catalog/agents", { fetchImpl });
        const agent = catalog.find((entry) => entry.creator_id === creatorId && entry.product_id === productId);
        if (!agent) {
          return send(response, 404, { error: { code: "agent_unavailable", message: "The published Agent could not be found." } });
        }
        const product = catalogAgentToProduct(agent);

        // Payment is intentionally a zero-value checkout for this stage. The
        // order still goes through the same paid/order/entitlement path so a
        // real provider can replace this boundary later without changing the
        // consumer or Runtime contracts.
        const orderKey = `order:${authentication.profile.id}:${creatorId}:${productId}`;
        const existing = ledger.findByIdempotencyKey(orderKey);
        if (existing) {
          const grant = await registryRequest(
            registryUrl,
            `/v1/user/agents/${encodeURIComponent(creatorId)}/${encodeURIComponent(agent.agent_id)}/access`,
            { method: "POST", body: JSON.stringify({ order_id: existing.order_id }), fetchImpl, headers: { authorization: `Bearer ${bearerToken(request)}` } }
          );
          await recordEntitlementGrant(ledger, existing, grant);
          return send(response, 200, { order: projectBuyerOrders(ledger.listEvents(), authentication.profile.id).find((order) => order.order_id === existing.order_id), payment: zeroPayment(existing.order_id, existing.currency), entitlement: grant });
        }

        const orderId = `order_${randomId()}`;
        const order = await ledger.append("order.placed", {
          order_id: orderId,
          buyer_id: authentication.profile.id,
          buyer_display_name: authentication.profile.display_name,
          creator_id: creatorId,
          agent_id: agent.agent_id,
          product_id: productId,
          product_name: product.name,
          corpus_digest: agent.corpus_digest,
          gross_minor: 0,
          currency: product.currency,
          payment_status: "paid",
          payment_id: `pay_zero_${orderId.slice("order_".length)}`
        }, { idempotencyKey: orderKey });
        const grant = await registryRequest(
          registryUrl,
          `/v1/user/agents/${encodeURIComponent(creatorId)}/${encodeURIComponent(agent.agent_id)}/access`,
          { method: "POST", body: JSON.stringify({ order_id: order.order_id }), fetchImpl, headers: { authorization: `Bearer ${bearerToken(request)}` } }
        );
        await recordEntitlementGrant(ledger, order, grant);
        return send(response, 201, {
          order: projectBuyerOrders(ledger.listEvents(), authentication.profile.id).find((entry) => entry.order_id === order.order_id),
          payment: zeroPayment(order.order_id, product.currency),
          entitlement: grant
        });
      }

      const accessMatch = url.pathname.match(/^\/v1\/user\/agents\/([^/]+)\/([^/]+)\/access$/);
      if (request.method === "POST" && accessMatch) {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        return send(response, 201, await registryRequest(
          registryUrl,
          `/v1/user/agents/${encodeURIComponent(accessMatch[1])}/${encodeURIComponent(accessMatch[2])}/access`,
          { method: "POST", fetchImpl, headers: { authorization: `Bearer ${bearerToken(request)}` } }
        ));
      }

      if (request.method === "GET" && url.pathname === "/v1/creator/agents") {
        const authentication = await authenticate(request, registryUrl, "creator", fetchImpl);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        return send(response, 200, await registryRequest(registryUrl, "/v1/creator/agents", {
          fetchImpl,
          headers: { authorization: `Bearer ${bearerToken(request)}` }
        }));
      }

      if (url.pathname.startsWith("/v1/creator/")) {
        const authentication = await authenticate(request, registryUrl, "creator", fetchImpl);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const profile = authentication.profile;
        const projection = projectCreatorDashboard(ledger.listEvents(), profile.id);
        const creatorProducts = async () => {
          const agents = await registryRequest(registryUrl, "/v1/creator/agents", {
            fetchImpl,
            headers: { authorization: `Bearer ${bearerToken(request)}` }
          });
          return Array.isArray(agents) ? agents.map(catalogAgentToProduct) : [];
        };
        if (request.method === "GET" && url.pathname === "/v1/creator/me") {
          return send(response, 200, publicProfile(profile));
        }
        if (request.method === "GET" && url.pathname === "/v1/creator/overview") {
          return send(response, 200, {
            metrics: projection.metrics,
            products: await creatorProducts(),
            recent_orders: projection.orders.slice(0, 5)
          });
        }
        if (request.method === "GET" && url.pathname === "/v1/creator/products") {
          return send(response, 200, { products: await creatorProducts() });
        }
        if (request.method === "GET" && url.pathname === "/v1/creator/orders") {
          return send(response, 200, { orders: projection.orders });
        }
        if (request.method === "GET" && url.pathname === "/v1/creator/payouts") {
          return send(response, 200, {
            available_minor: projection.metrics.creator_share_minor,
            pending_minor: 0,
            paid_minor: 0,
            currency: "USD",
            next_payout_at: null
          });
        }
      }

      if (request.method === "GET" && url.pathname === "/v1/buyer/entitlements") {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        return send(response, 200, {
          buyer_id: authentication.profile.id,
          entitlements: projectBuyerEntitlements(ledger.listEvents(), authentication.profile.id)
        });
      }
      return send(response, 404, { error: { code: "not_found", message: "Route not found." } });
    } catch (error) {
      return send(response, error.status ?? 500, {
        error: {
          code: error.code ?? "internal_error",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  };

  return { handler, ledger };
}

export async function startDashboardServer(options = {}) {
  const app = await createDashboardApp(options);
  const port = Number(options.port ?? process.env.HATCH_CREATOR_DASHBOARD_API_PORT ?? 8500);
  const host = options.host ?? process.env.HATCH_CREATOR_DASHBOARD_API_HOST ?? "127.0.0.1";
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(port, host, resolve));
  return { ...app, server, port, host };
}

async function registryRequest(registryUrl, pathname, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { fetchImpl: _fetchImpl, ...requestOptions } = options;
  const response = await fetchImpl(new URL(pathname, registryUrl), {
    ...requestOptions,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) }
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.detail ?? "Registry rejected the Agent request.");
    error.status = response.status;
    error.code = "registry_rejected_agent_request";
    throw error;
  }
  return payload;
}

async function authenticate(request, registryUrl, expectedRole, fetchImpl) {
  const token = bearerToken(request);
  if (!token) {
    return { error: { status: 401, body: { error: { code: "unauthorized", message: "Sign in to continue." } } } };
  }
  try {
    const account = await registryRequest(registryUrl, "/v1/auth/me", {
      fetchImpl,
      headers: { authorization: `Bearer ${token}` }
    });
    const profile = publicProfile(account);
    if (expectedRole && profile.role !== expectedRole) {
      return { error: { status: 403, body: { error: { code: `${expectedRole}_only`, message: `This area is for ${expectedRole}s.` } } } };
    }
    return { profile };
  } catch {
    return { error: { status: 401, body: { error: { code: "unauthorized", message: "Sign in to continue." } } } };
  }
}

function publicProfile(profile) {
  const displayName = profile.display_name ?? profile.name ?? "Hatch account";
  const initials = displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "U";
  return {
    id: profile.id,
    role: profile.role,
    display_name: displayName,
    handle: profile.handle ?? `@${profile.id}`,
    initials
  };
}

function mergeRegistryAgents(access, catalog) {
  if (!Array.isArray(access) || !Array.isArray(catalog)) return [];
  const catalogByAgent = new Map(catalog.map((entry) => [
    `${entry?.creator_id}:${entry?.agent_id}`,
    entry
  ]));
  return access.flatMap((grant) => {
    const entry = catalogByAgent.get(`${grant?.creator_id}:${grant?.agent_id}`);
    if (!entry) return [];
    return [{
      ...grant,
      creator: { id: entry.creator_id, name: entry.creator_name },
      product: {
        id: entry.product_id,
        name: entry.product_name,
        description: entry.product_description || "Work with this Creator Agent in your own files and context.",
        promise: entry.product_promise || entry.product_description || ""
      },
      presentation: entry.presentation ?? {}
    }];
  });
}

function randomId() {
  return randomUUID().replaceAll("-", "");
}

function zeroPayment(orderId, currency = "USD") {
  return {
    payment_id: `pay_zero_${orderId.slice("order_".length)}`,
    status: "paid",
    amount_minor: 0,
    currency
  };
}

async function recordEntitlementGrant(ledger, order, grant) {
  const existing = ledger.listEvents().find((event) => (
    event.event_type === "entitlement.granted" && event.order_id === order.order_id
  ));
  if (existing) return existing;
  return ledger.append("entitlement.granted", {
    entitlement_id: grant.entitlement_id,
    order_id: order.order_id,
    buyer_id: order.buyer_id,
    creator_id: order.creator_id,
    agent_id: order.agent_id,
    product_id: order.product_id,
    corpus_digest: order.corpus_digest
  }, { idempotencyKey: `entitlement:${order.order_id}` });
}

function catalogAgentToProduct(agent) {
  const offer = agent?.product_offer ?? {};
  return {
    product_id: agent.product_id,
    creator_id: agent.creator_id,
    agent_id: agent.agent_id,
    corpus_digest: agent.corpus_digest,
    name: agent.product_name,
    description: agent.product_description ?? "",
    promise: agent.product_promise ?? agent.product_description ?? "",
    boundaries: agent.product_boundaries ?? [],
    status: "published",
    price_minor: Number.isInteger(offer.amount_minor) ? offer.amount_minor : 0,
    currency: offer.currency ?? "USD",
    pricing_model: offer.model ?? null,
    published_at: agent.published_at ?? null,
    presentation: agent.presentation ?? {}
  };
}

function bearerToken(request) {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : undefined;
}

async function readJson(request) {
  let content = "";
  for await (const chunk of request) content += chunk;
  return content ? JSON.parse(content) : {};
}

function send(response, status, body) {
  response.statusCode = status;
  response.setHeader("access-control-allow-origin", "http://127.0.0.1:8510");
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  if (body === undefined) return response.end();
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function servePortalAsset(requestPath, response) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(requestPath === "/portal" || requestPath === "/portal/"
      ? "index.html"
      : requestPath.slice("/portal/".length));
  } catch {
    return send(response, 400, { error: { code: "invalid_path", message: "Invalid portal asset path." } });
  }
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    return send(response, 400, { error: { code: "invalid_path", message: "Invalid portal asset path." } });
  }
  const assetRoot = path.join(currentDirectory, "dist");
  const assetPath = path.join(assetRoot, relativePath);
  try {
    const body = await readFile(assetPath);
    response.writeHead(200, {
      "content-type": contentType(assetPath),
      "cache-control": relativePath === "index.html" ? "no-cache" : "public, max-age=31536000, immutable"
    });
    response.end(body);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT" || path.extname(relativePath)) {
      return send(response, error?.code === "ENOENT" ? 404 : 500, { error: { code: "portal_asset_not_found", message: "Portal asset not found." } });
    }
    // Client-side routes under /portal/ resolve through the SPA entrypoint.
    try {
      const body = await readFile(path.join(assetRoot, "index.html"));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      response.end(body);
      return;
    } catch (fallbackError) {
      return send(response, 500, { error: { code: "portal_unavailable", message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) } });
    }
  }
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  }[extension] ?? "application/octet-stream";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { host, port } = await startDashboardServer();
  console.log(`Hatch Creator Dashboard API listening on http://${host}:${port}`);
}
