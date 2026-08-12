import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { runCommerceV2Smoke } from "../../scripts/commerce-v2-smoke.mjs";

test("production Commerce smoke covers public metadata and an idempotent authenticated free receipt", async (context) => {
  const commands = new Map();
  const confirmations = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://smoke.test");
    let content = "";
    for await (const chunk of request) content += chunk;
    const body = content ? JSON.parse(content) : {};
    const origin = serverUrl(server);
    response.setHeader("content-type", "application/json");

    if (url.pathname === "/agents/maya-chen/signal-resume-review") {
      response.setHeader("content-type", "text/html");
      response.end(`<html><head><link rel="canonical" href="${origin}${url.pathname}" /></head></html>`);
      return;
    }
    if (url.pathname === "/v1/catalog/agents/maya-chen/signal-resume-review") {
      response.end(JSON.stringify({ agent: product() }));
      return;
    }
    if (url.pathname === "/v1/auth/login" && request.method === "POST") {
      assert.deepEqual(body, { email: "smoke@example.test", password: "secret-from-environment" });
      response.setHeader("set-cookie", [
        "hatch_web_session=session-smoke; Path=/; HttpOnly; SameSite=Lax",
        "hatch_web_csrf=csrf-smoke; Path=/; SameSite=Lax"
      ]);
      response.end(JSON.stringify({ profile: { id: "buyer-smoke", role: "user" } }));
      return;
    }
    if (url.pathname === "/v1/auth/me") {
      assert.match(String(request.headers.cookie), /hatch_web_session=session-smoke/);
      response.end(JSON.stringify({ id: "buyer-smoke", role: "user" }));
      return;
    }
    if (url.pathname === "/v1/checkout-sessions" && request.method === "POST") {
      assert.equal(request.headers["x-csrf-token"], "csrf-smoke");
      assert.equal(body.offer_id, "offer-smoke");
      const key = String(request.headers["idempotency-key"]);
      commands.set(key, commands.get(key) ?? "checkout-smoke");
      response.statusCode = 201;
      response.end(JSON.stringify({
        checkout_session: {
          checkout_session_id: commands.get(key),
          totals: { total_minor: 0, currency: "USD" }
        }
      }));
      return;
    }
    if (url.pathname === "/v1/checkout-sessions/checkout-smoke/confirm" && request.method === "POST") {
      assert.equal(request.headers["x-csrf-token"], "csrf-smoke");
      const key = String(request.headers["idempotency-key"]);
      confirmations.set(key, confirmations.get(key) ?? "order-smoke");
      response.statusCode = 201;
      response.end(JSON.stringify({
        order_id: "order-smoke",
        entitlement_id: "entitlement-smoke",
        payment: { status: "not_required" }
      }));
      return;
    }
    if (url.pathname === "/v1/user/orders/order-smoke") {
      response.end(JSON.stringify({
        order: {
          order_id: "order-smoke",
          offer_id: "offer-smoke",
          offer_revision: 1,
          release_id: `sha256:${"a".repeat(64)}`,
          corpus_digest: `sha256:${"a".repeat(64)}`,
          gross_minor: 0,
          subtotal_minor: 0,
          discount_minor: 0,
          tax_minor: null,
          total_minor: 0,
          currency: "USD",
          payment_status: "not_required",
          payment_id: null
        }
      }));
      return;
    }
    if (url.pathname === "/v1/user/entitlements/entitlement-smoke") {
      response.end(JSON.stringify({
        entitlement: {
          entitlement_id: "entitlement-smoke",
          order_id: "order-smoke",
          creator_id: "maya-chen",
          product_id: "signal-resume-review",
          purchased_corpus_digest: `sha256:${"a".repeat(64)}`,
          effective_corpus_digest: `sha256:${"a".repeat(64)}`,
          status: "active",
          remaining_units: 1
        }
      }));
      return;
    }
    if (url.pathname === "/portal/orders/order-smoke/success" || url.pathname === "/download") {
      response.setHeader("content-type", "text/html");
      response.end("<html>Hatch</html>");
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: "not_found" } }));
  });
  await listen(server);
  context.after(() => server.close());

  const publicOnly = await runCommerceV2Smoke({ origin: serverUrl(server) });
  assert.equal(publicOnly.mode, "public");
  const authenticated = await runCommerceV2Smoke({
    origin: serverUrl(server),
    email: "smoke@example.test",
    password: "secret-from-environment",
    releaseTag: "application-sha-one"
  });
  assert.deepEqual(authenticated, {
    mode: "authenticated",
    creator_id: "maya-chen",
    product_id: "signal-resume-review",
    order_id: "order-smoke",
    entitlement_id: "entitlement-smoke"
  });
  const replay = await runCommerceV2Smoke({
    origin: serverUrl(server),
    email: "smoke@example.test",
    password: "secret-from-environment",
    releaseTag: "unrelated-application-sha-two"
  });
  assert.equal(replay.order_id, authenticated.order_id);
  assert.equal(commands.size, 1);
  assert.equal(confirmations.size, 1);
  assert.match([...commands.keys()][0], /^production-smoke:[a-f0-9]{64}:create$/);
});

function product() {
  return {
    creator_id: "maya-chen",
    product_id: "signal-resume-review",
    available: true,
    availability: "published",
    corpus_digest: `sha256:${"a".repeat(64)}`,
    release_id: `sha256:${"a".repeat(64)}`,
    offer: { offer_id: "offer-smoke", revision: 1, amount_minor: 0, currency: "USD" }
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}
