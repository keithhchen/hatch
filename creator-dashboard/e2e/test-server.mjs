import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startDashboardServer } from "../server.mjs";
import { CommerceLedger } from "../../packages/commerce/src/ledger.js";
import { CommerceService } from "../../packages/commerce/src/service.js";

const dashboardPort = Number(process.env.HATCH_E2E_PORT ?? 18_500);
const registryPort = Number(process.env.HATCH_E2E_REGISTRY_PORT ?? dashboardPort + 1);
const commerceServiceToken = "e2e-runtime-commerce-secret";
const controlToken = "hatch-commerce-v2-e2e-control";
const CREATOR_ID = "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21";
const PUBLIC_PRODUCT_ID = "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42";
const PAGINATION_PRODUCT_ID = "d4b6f3a1-2c87-4e59-9a10-6b7c8d9e0f12";
const corpusDigest = `sha256:${"a".repeat(64)}`;
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-e2e-"));
const accounts = new Map([
  ["buyer@example.test", { id: "a4f1c2d3-5678-4a90-bcde-1234567890ab", display_name: "Jordan Buyer", password: "buyer-password", token: "buyer-e2e-token" }],
  ["creator@example.test", { id: CREATOR_ID, display_name: "Maya Creator", password: "creator-password", token: "creator-e2e-token" }]
]);
const accountsByToken = new Map([...accounts.values()].map((account) => [account.token, account]));
let dashboard;

const baseAgent = {
  creator_id: CREATOR_ID,
  creator_name: "Maya Creator",
  creator_verified: true,
  agent_id: PUBLIC_PRODUCT_ID,
  product_id: PUBLIC_PRODUCT_ID,
  product_name: "Signal Resume Review",
  product_description: "Turn a real resume into an evidence-backed rewrite plan.",
  product_promise: "Find the strongest credible signal without inventing evidence.",
  product_boundaries: ["Does not invent employers, metrics, or outcomes."],
  corpus_digest: corpusDigest,
  status: "published",
  published_at: "2026-08-12T08:00:00.000Z",
  presentation: {
    inputs: ["A resume and target role"],
    outputs: ["Evidence-backed rewrite plan"],
    privacy_copy: "Your Workspace files and conversation stay out of Creator commerce views."
  }
};
const agents = new Map([[baseAgent.product_id, baseAgent]]);
const registry = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://registry.e2e");
    if (url.pathname.startsWith("/__e2e/")) {
      if (request.headers["x-hatch-e2e-control"] !== controlToken) {
        return json(response, 404, { detail: "Not found." });
      }
      if (request.method === "POST" && url.pathname === "/__e2e/release") {
        const body = await readJson(request);
        const current = agents.get(String(body.product_id));
        if (!current) return json(response, 404, { detail: "Product not found." });
        current.corpus_digest = String(body.corpus_digest);
        return json(response, 200, { agent: current });
      }
      if (request.method === "GET" && url.pathname === "/__e2e/commerce") {
        const buyerId = String(url.searchParams.get("buyer_id") ?? "");
        const events = dashboard?.ledger.listEvents().filter((event) => !buyerId || event.buyer_id === buyerId) ?? [];
        return json(response, 200, {
          events: events.map((event) => ({
            event_id: event.event_id,
            event_type: event.event_type,
            buyer_id: event.buyer_id,
            order_id: event.order_id,
            entitlement_id: event.entitlement_id,
            idempotency_key: event.idempotency_key
          })),
          access: dashboard?.commerce.listBuyerEntitlements(buyerId)
            .filter((entry) => entry.status === "active") ?? []
        });
      }
      return json(response, 404, { detail: `E2E control route not found: ${request.method} ${url.pathname}` });
    }
    if (request.method === "GET" && ["/healthz", "/readyz"].includes(url.pathname)) {
      return json(response, 200, { status: "ok" });
    }
    if (request.method === "POST" && url.pathname === "/v1/auth/signin") {
      const body = await readJson(request);
      const account = accounts.get(String(body.email ?? ""));
      if (!account || account.password !== body.password) return json(response, 401, { detail: "Email or password is incorrect." });
      return json(response, 200, { token: account.token, account: publicAccount(account) });
    }
    if (request.method === "POST" && url.pathname === "/v1/auth/signup") {
      const body = await readJson(request);
      const email = String(body.email ?? "");
      if (accounts.has(email)) return json(response, 409, { detail: "Email is already registered." });
      const account = {
        id: randomUUID(),
        display_name: String(body.display_name ?? "New Buyer"),
        password: String(body.password ?? ""),
        token: `buyer-e2e-token-${accounts.size + 1}`
      };
      accounts.set(email, account);
      accountsByToken.set(account.token, account);
      return json(response, 201, { token: account.token, account: publicAccount(account) });
    }
    if (request.method === "GET" && url.pathname === "/v1/auth/me") {
      const account = authenticatedAccount(request);
      return account
        ? json(response, 200, publicAccount(account))
        : json(response, 401, { detail: "A valid account token is required." });
    }
    if (request.method === "GET" && url.pathname === "/v1/public/products") {
      return json(response, 200, [...agents.values()].filter((entry) => entry.status === "published"));
    }
    const publicCreatorMatch = url.pathname.match(/^\/v1\/public\/creators\/([^/]+)$/);
    if (request.method === "GET" && publicCreatorMatch) {
      const creatorId = decodeURIComponent(publicCreatorMatch[1]);
      const products = [...agents.values()].filter((entry) => entry.status === "published" && entry.creator_id === creatorId);
      if (!products.length) return json(response, 404, { detail: "Creator not found." });
      return json(response, 200, {
        creator: { id: creatorId, name: products[0].creator_name },
        products
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/creator/products") {
      const account = authenticatedAccount(request);
      return account ? json(response, 200, [...agents.values()].filter((entry) => entry.creator_id === account.id)) : json(response, 401, { detail: "A valid account token is required." });
    }
    return json(response, 404, { detail: `Registry E2E route not found: ${request.method} ${url.pathname}` });
  } catch (error) {
    return json(response, 500, { detail: error instanceof Error ? error.message : String(error) });
  }
});

await listen(registry, registryPort);
const registryAddress = registry.address();
if (!registryAddress || typeof registryAddress === "string") throw new Error("E2E Registry did not bind a TCP port");

const ledgerPath = path.join(temporaryDirectory, "commerce.jsonl");
const ledger = await CommerceLedger.open({ filePath: ledgerPath });
await seedCreatorOrders(new CommerceService(ledger));
dashboard = await startDashboardServer({
  host: "127.0.0.1",
  port: dashboardPort,
  publicOrigin: `http://127.0.0.1:${dashboardPort}`,
  registryUrl: `http://127.0.0.1:${registryAddress.port}`,
  ledger,
  ledgerPath,
  portalStatePath: path.join(temporaryDirectory, "portal-state.json"),
  commerceRuntimeServiceToken: commerceServiceToken,
  paymentMode: "disabled"
});

console.log(`Hatch dashboard E2E ready at http://127.0.0.1:${dashboardPort}`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.all([
    closeServer(dashboard.server),
    closeServer(registry)
  ]);
  await rm(temporaryDirectory, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void close().finally(() => process.exit(0)); });
}

function authenticatedAccount(request) {
  return accountsByToken.get(bearer(request));
}

function bearer(request) {
  const value = String(request.headers.authorization ?? "");
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function publicAccount(account) {
  return { id: account.id, display_name: account.display_name };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}




async function seedCreatorOrders(commerce) {
  for (let index = 1; index <= 13; index += 1) {
    await commerce.confirmCheckout({
      buyer_id: randomUUID(),
      buyer_display_name: `Pagination Buyer ${index}`,
      creator_id: CREATOR_ID,
      creator_display_name: "Maya Creator",
      agent_id: PAGINATION_PRODUCT_ID,
      product_id: PAGINATION_PRODUCT_ID,
      product_name: "Pagination Product",
      corpus_digest: `sha256:${"d".repeat(64)}`,
      release_id: `sha256:${"d".repeat(64)}`,
      gross_minor: 0,
      currency: "USD",
      included_units: 1,
      version_policy: "pinned",
      refund_policy_version: "free-v1"
    }, { idempotencyKey: `e2e-pagination-order-${index}` });
  }
}
