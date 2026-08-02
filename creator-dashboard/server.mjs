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
import { CreatorProductStore } from "./src/product-store.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export async function createDashboardApp(options = {}) {
  const ledgerPath = options.ledgerPath
    ?? process.env.HATCH_COMMERCE_LEDGER_PATH
    ?? path.join(currentDirectory, ".local-uat", "ledger.jsonl");
  const productStatePath = options.productStatePath
    ?? process.env.HATCH_CREATOR_PRODUCT_STATE_PATH
    ?? path.join(currentDirectory, ".local-uat", "product-state.json");
  const productCatalogPath = options.productCatalogPath
    ?? process.env.HATCH_CREATOR_PRODUCT_CATALOG_PATH;
  if (!productCatalogPath) {
    throw new Error("Configure HATCH_CREATOR_PRODUCT_CATALOG_PATH with an imported Dashboard product catalog.");
  }
  const registryUrl = options.registryUrl
    ?? process.env.HATCH_REGISTRY_URL
    ?? "http://127.0.0.1:8100";
  const registryPublishServiceToken = options.registryPublishServiceToken
    ?? process.env.HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN;
  if (!registryPublishServiceToken) {
    throw new Error("Configure HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN for authenticated Registry publishing.");
  }

  const [ledger, products] = await Promise.all([
    CommerceLedger.open({ filePath: ledgerPath }),
    CreatorProductStore.open({
      catalogPath: path.resolve(productCatalogPath),
      statePath: productStatePath
    })
  ]);
  const fetchImpl = options.fetchImpl ?? fetch;

  const handler = async (request, response) => {
    try {
      if (request.method === "OPTIONS") return send(response, 204, undefined);
      const url = new URL(request.url ?? "/", "http://dashboard.local");
      if (request.method === "GET" && url.pathname === "/healthz") {
        return send(response, 200, { ok: true });
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
        const product = products.getForCreator(creatorId, productId);
        if (!product) {
          return send(response, 404, { error: { code: "product_unavailable", message: "This Agent is not currently available for purchase." } });
        }
        const catalog = await registryRequest(registryUrl, "/v1/catalog/agents", { fetchImpl });
        const agent = catalog.find((entry) => entry.creator_id === creatorId && entry.product_id === productId);
        if (!agent) {
          return send(response, 404, { error: { code: "agent_unavailable", message: "The published Agent could not be found." } });
        }

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
            { method: "POST", fetchImpl, headers: { authorization: `Bearer ${bearerToken(request)}` } }
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
          product_id: productId,
          product_name: product.name,
          release_id: product.release_id,
          release_digest: product.release_digest,
          gross_minor: 0,
          currency: product.currency,
          payment_status: "paid",
          payment_id: `pay_zero_${orderId.slice("order_".length)}`
        }, { idempotencyKey: orderKey });
        const grant = await registryRequest(
          registryUrl,
          `/v1/user/agents/${encodeURIComponent(creatorId)}/${encodeURIComponent(agent.agent_id)}/access`,
          { method: "POST", fetchImpl, headers: { authorization: `Bearer ${bearerToken(request)}` } }
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
        if (request.method === "GET" && url.pathname === "/v1/creator/me") {
          return send(response, 200, publicProfile(profile));
        }
        if (request.method === "GET" && url.pathname === "/v1/creator/voice") {
          const voice = await registryRequest(registryUrl, `/v1/creators/${encodeURIComponent(profile.id)}/voice`, {
            fetchImpl,
            headers: { authorization: `Bearer ${bearerToken(request)}` },
            allow404: true
          });
          if (voice === null) return send(response, 404, { error: { code: "voice_not_configured", message: "Record your voice to enable voice playback." } });
          return send(response, 200, voice);
        }
        if (request.method === "PUT" && url.pathname === "/v1/creator/voice") {
          const voice = await registryRequest(registryUrl, `/v1/creators/${encodeURIComponent(profile.id)}/voice`, {
            method: "PUT",
            fetchImpl,
            headers: { authorization: `Bearer ${bearerToken(request)}` },
            rawBody: await readRaw(request),
            rawContentType: request.headers["content-type"]
          });
          return send(response, 201, voice);
        }
        if (request.method === "DELETE" && url.pathname === "/v1/creator/voice") {
          await registryRequest(registryUrl, `/v1/creators/${encodeURIComponent(profile.id)}/voice`, {
            method: "DELETE",
            fetchImpl,
            headers: { authorization: `Bearer ${bearerToken(request)}` }
          });
          return send(response, 204, undefined);
        }
        if (request.method === "GET" && url.pathname === "/v1/creator/overview") {
          return send(response, 200, {
            metrics: projection.metrics,
            products: products.listForCreator(profile.id),
            recent_orders: projection.orders.slice(0, 5)
          });
        }
        if (request.method === "GET" && url.pathname === "/v1/creator/products") {
          return send(response, 200, { products: products.listForCreator(profile.id) });
        }
        const publishMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/publish$/);
        if (request.method === "POST" && publishMatch) {
          const productId = decodeURIComponent(publishMatch[1]);
          const currentProduct = products.getForCreator(profile.id, productId);
          if (currentProduct?.status === "published") {
            return send(response, 409, {
              error: {
                code: "already_published",
                message: "This exact product release is already published.",
                release_id: currentProduct.release_id,
                release_digest: currentProduct.release_digest,
                published_at: currentProduct.published_at
              }
            });
          }
          const publishRequest = products.getPublishRequest(profile.id, productId);
          if (!publishRequest) {
            return send(response, 409, {
              error: {
                code: "product_not_publishable",
                message: "This product has not completed its release checks."
              }
            });
          }
          // Agent Corpus publication is owned by the Factory's --publish flow.
          // Dashboard only confirms that the canonical TypeScript Registry has
          // the exact Agent available before recording its own UI state.
          const catalog = await registryRequest(registryUrl, "/v1/catalog/agents", {
            fetchImpl,
            headers: { authorization: `Bearer ${registryPublishServiceToken}` }
          });
          const agent = Array.isArray(catalog)
            ? catalog.find((entry) => entry?.creator_id === profile.id && entry?.product_id === productId)
            : null;
          if (!agent) {
            return send(response, 409, {
              error: {
                code: "agent_not_published",
                message: "Publish this Agent Corpus through the Factory before marking the product published."
              }
            });
          }
          const registryRecord = {
            ...publishRequest,
            creator_id: profile.id,
            product_id: productId,
            agent_id: agent.agent_id,
            corpus_digest: agent.corpus_digest,
            published_at: agent.published_at ?? new Date().toISOString()
          };
          const product = await products.markPublished(registryRecord);
          return send(response, 200, {
            product,
            registry: {
              release_id: registryRecord.release_id,
              release_digest: registryRecord.release_digest,
              published_at: registryRecord.published_at
            }
          });
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

  return { handler, ledger, products };
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
  const { fetchImpl: _fetchImpl, allow404, rawBody, rawContentType, ...requestOptions } = options;
  const headers = rawBody === undefined
    ? { "content-type": "application/json", ...(options.headers ?? {}) }
    : { ...(options.headers ?? {}) };
  if (rawBody !== undefined && rawContentType) headers["content-type"] = rawContentType;
  const response = await fetchImpl(new URL(pathname, registryUrl), {
    ...requestOptions,
    ...(rawBody !== undefined ? { body: rawBody } : {}),
    headers
  });
  if (response.status === 204) return undefined;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (allow404 && response.status === 404) return null;
    const error = new Error(payload?.detail ?? "Registry rejected the release.");
    error.status = response.status;
    error.code = "registry_rejected_release";
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
        description: entry.product_description || "Work with this Creator Agent in your own files and context."
      },
      presentation: {}
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
    product_id: order.product_id,
    release_id: order.release_id,
    release_digest: order.release_digest
  }, { idempotencyKey: `entitlement:${order.order_id}` });
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

async function readRaw(request, max = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > max) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(value);
  }
  return Buffer.concat(chunks);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { host, port } = await startDashboardServer();
  console.log(`Hatch Creator Dashboard API listening on http://${host}:${port}`);
}
