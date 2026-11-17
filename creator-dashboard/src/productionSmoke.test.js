import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { runProductionSmoke } from "../../scripts/production-smoke.mjs";

test("production smoke covers public metadata, sign-in and the library listing", async (context) => {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://smoke.test");
    let content = "";
    for await (const chunk of request) content += chunk;
    const body = content ? JSON.parse(content) : {};
    const origin = serverUrl(server);
    response.setHeader("content-type", "application/json");

    if (url.pathname === "/products/f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42") {
      response.setHeader("content-type", "text/html");
      response.end(`<html><head><link rel="canonical" href="${origin}${url.pathname}" /></head></html>`);
      return;
    }
    if (url.pathname === "/v1/public/products/f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42") {
      response.end(JSON.stringify({ product: product() }));
      return;
    }
    if (url.pathname === "/v1/auth/login" && request.method === "POST") {
      assert.deepEqual(body, { email: "smoke@example.test", password: "secret-from-environment" });
      response.setHeader("set-cookie", [
        "hatch_web_session=session-smoke; Path=/; HttpOnly; SameSite=Lax",
        "hatch_web_csrf=csrf-smoke; Path=/; SameSite=Lax"
      ]);
      response.end(JSON.stringify({ profile: { id: "buyer-smoke" } }));
      return;
    }
    if (url.pathname === "/v1/auth/me") {
      assert.match(String(request.headers.cookie), /hatch_web_session=session-smoke/);
      response.end(JSON.stringify({ id: "buyer-smoke" }));
      return;
    }
    if (url.pathname === "/v1/library") {
      assert.match(String(request.headers.cookie), /hatch_web_session=session-smoke/);
      response.end(JSON.stringify({ entitlements: [], next_cursor: null }));
      return;
    }
    if (url.pathname === "/download") {
      response.setHeader("content-type", "text/html");
      response.end("<html>Hatch</html>");
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: "not_found" } }));
  });
  await listen(server);
  context.after(() => server.close());

  const publicOnly = await runProductionSmoke({ origin: serverUrl(server) });
  assert.equal(publicOnly.mode, "public");
  const authenticated = await runProductionSmoke({
    origin: serverUrl(server),
    email: "smoke@example.test",
    password: "secret-from-environment"
  });
  assert.deepEqual(authenticated, {
    mode: "authenticated",
    creator_id: "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21",
    product_id: "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42"
  });
});

function product() {
  return {
    creator_id: "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21",
    product_id: "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42",
    available: true,
    availability: "published",
    corpus_digest: `sha256:${"a".repeat(64)}`,
    release_id: `sha256:${"a".repeat(64)}`
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}
