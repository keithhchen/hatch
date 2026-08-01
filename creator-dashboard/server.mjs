import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CommerceLedger,
  projectBuyerEntitlements,
  projectCreatorDashboard
} from "../packages/commerce/src/index.js";
import { CreatorProductStore } from "./src/product-store.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export async function createDashboardApp(options = {}) {
  const fixturePath = options.fixturePath
    ?? process.env.HATCH_CREATOR_DASHBOARD_FIXTURE_PATH
    ?? path.join(currentDirectory, "fixtures/local-uat.json");
  const fixture = options.fixture ?? JSON.parse(await readFile(fixturePath, "utf8"));
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

  const sessions = new Map();
  const profiles = new Map(fixture.profiles.map((profile) => [profile.email.toLowerCase(), profile]));

  const handler = async (request, response) => {
    try {
      if (request.method === "OPTIONS") return send(response, 204, undefined);
      const url = new URL(request.url ?? "/", "http://dashboard.local");
      if (request.method === "GET" && url.pathname === "/healthz") {
        return send(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/login") {
        const body = await readJson(request);
        const profile = profiles.get(String(body.email ?? "").toLowerCase());
        if (!profile || profile.password !== body.password) {
          return send(response, 401, { error: { code: "invalid_credentials", message: "Email or password is incorrect." } });
        }
        const token = `local_${profile.role}_${profile.id}`;
        sessions.set(token, profile);
        return send(response, 200, { token, profile: publicProfile(profile) });
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
        const token = bearerToken(request);
        if (token) sessions.delete(token);
        return send(response, 204, undefined);
      }

      if (url.pathname.startsWith("/v1/creator/")) {
        const authentication = authenticate(request, sessions, "creator");
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const profile = authentication.profile;
        const projection = projectCreatorDashboard(ledger.listEvents(), profile.id);
        if (request.method === "GET" && url.pathname === "/v1/creator/me") {
          return send(response, 200, publicProfile(profile));
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
          const registryRecord = await registryRequest(registryUrl, "/v1/creator/releases", {
            method: "POST",
            body: JSON.stringify(publishRequest),
            headers: {
              authorization: `Bearer ${registryPublishServiceToken}`,
              "x-hatch-creator-id": profile.id
            }
          });
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
        const authentication = authenticate(request, sessions, "buyer");
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

async function registryRequest(registryUrl, pathname, options) {
  const response = await fetch(new URL(pathname, registryUrl), {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) }
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.detail ?? "Registry rejected the release.");
    error.status = response.status;
    error.code = "registry_rejected_release";
    throw error;
  }
  return payload;
}

function authenticate(request, sessions, expectedRole) {
  const token = bearerToken(request);
  const profile = token ? sessions.get(token) : undefined;
  if (!profile) {
    return { error: { status: 401, body: { error: { code: "unauthorized", message: "Sign in to continue." } } } };
  }
  if (profile.role !== expectedRole) {
    return { error: { status: 403, body: { error: { code: `${expectedRole}_only`, message: `This area is for ${expectedRole}s.` } } } };
  }
  return { profile };
}

function publicProfile(profile) {
  return {
    id: profile.id,
    role: profile.role,
    display_name: profile.display_name,
    handle: profile.handle,
    initials: profile.initials
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { host, port } = await startDashboardServer();
  console.log(`Hatch Creator Dashboard API listening on http://${host}:${port}`);
}
