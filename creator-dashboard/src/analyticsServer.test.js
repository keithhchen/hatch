import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";

const account = { id: "account-1", email: "a@example.test", display_name: "A" };

async function setup(context, analytics) {
  const registry = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const created = request.url === "/v1/auth/signup";
    response.statusCode = created ? 201 : 200;
    response.end(JSON.stringify({ token: "registry-token", account }));
  });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({ registryUrl: serverUrl(registry), analytics });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  return (pathname, status) => fetch(`${serverUrl(api)}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: account.email, password: "test-only", display_name: "A" })
  }).then(response => { assert.equal(response.status, status); });
}

test("sign-up and sign-in emit analytics events for the account id", async (context) => {
  const captured = [];
  const post = await setup(context, { capture: (distinctId, event) => captured.push({ distinctId, ...event }) });
  await post("/v1/auth/signup", 201);
  await post("/v1/auth/login", 200);
  assert.deepEqual(captured, [
    { distinctId: "account-1", event: "signup_completed", properties: { method: "password" } },
    { distinctId: "account-1", event: "signed_in", properties: { method: "password" } }
  ]);
});

test("a throwing analytics adapter never fails a request", async (context) => {
  const post = await setup(context, { capture() { throw new Error("posthog down"); } });
  await post("/v1/auth/login", 200);
  await post("/v1/auth/signup", 201);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}
