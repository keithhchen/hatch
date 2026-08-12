import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(process.cwd(), "..");

test("production keeps browser APIs on the Dashboard BFF and disables legacy HMAC auth", async () => {
  const caddyfile = await readFile(path.join(repositoryRoot, "Caddyfile"), "utf8");
  assert.doesNotMatch(caddyfile, /^\s*@registry_api\b/m,
    "the Registry must not own a broad public browser API matcher");
  assert.match(caddyfile, /handle \/v1\/\*\s*\{[\s\S]*?reverse_proxy dashboard:8500/,
    "all browser APIs must reach the cookie-backed Dashboard BFF");
  const registryHealthBlock = caddyfile.match(/handle @registry_health \{([\s\S]*?)\n    \}/)?.[1] ?? "";
  assert.doesNotMatch(registryHealthBlock, /\/v1\//,
    "public routing must not expose Registry command routes");
  const runtimeMatcher = caddyfile.match(/^\s*@runtime_api path ([^\n]+)$/m)?.[1];
  assert.ok(runtimeMatcher, "Caddyfile must declare the Runtime HTTP API matcher");
  assert.match(runtimeMatcher, /(?:^|\s)\/v1\/conversations\*(?:\s|$)/,
    "Conversation Library routes must reach Runtime before the Dashboard /v1 catch-all");

  const deployWorkflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "deploy.yml"),
    "utf8"
  );
  const requiredKeys = deployWorkflow.match(/for key in ([^;\n]+); do/)?.[1];
  assert.ok(requiredKeys, "deploy workflow must validate production secrets");
  assert.doesNotMatch(requiredKeys, /HATCH_AUTH_SIGNING_SECRET/);
  assert.match(requiredKeys, /HATCH_REGISTRY_COMMERCE_SERVICE_TOKEN/);
  assert.match(requiredKeys, /HATCH_RUNTIME_DB_PASSWORD/);
  assert.match(deployWorkflow, /^  verify-server:\n/m);
  assert.match(
    deployWorkflow,
    /^  build-and-push:\n(?:.*\n)*?    needs: verify-server$/m,
    "server images must not be built or deployed until their release checks pass"
  );
});

test("production trusts forwarded client IP only on the private Registry network", async () => {
  const compose = await readFile(path.join(repositoryRoot, "compose.app.yml"), "utf8");
  const registryService = compose.match(/^  registry:\n([\s\S]*?)(?=^  [a-z][a-z0-9_-]*:\n)/m)?.[1];
  assert.ok(registryService, "compose.app.yml must declare the Registry service");
  assert.doesNotMatch(registryService, /^    ports:/m, "Registry must not be published on the host");
  assert.match(
    registryService,
    /HATCH_AUTH_TRUSTED_PROXY_CIDRS:/,
    "the private-network deployment must explicitly configure its trusted proxy boundary"
  );
  const runtimeService = compose.match(/^  runtime:\n([\s\S]*?)(?=^  [a-z][a-z0-9_-]*:\n)/m)?.[1];
  assert.ok(runtimeService, "compose.app.yml must declare the Runtime service");
  assert.match(
    runtimeService,
    /HATCH_AUTH_TRUSTED_PROXY_CIDRS:/,
    "Runtime must apply the same explicit Caddy trust boundary before using forwarded client IPs"
  );
  const dashboardService = compose.match(/^  dashboard:\n([\s\S]*?)(?=^  [a-z][a-z0-9_-]*:\n)/m)?.[1];
  assert.ok(dashboardService, "compose.app.yml must declare the Dashboard service");
  assert.match(registryService, /HATCH_REGISTRY_COMMERCE_SERVICE_TOKEN:/);
  assert.match(dashboardService, /HATCH_REGISTRY_COMMERCE_SERVICE_TOKEN:/);
});

test("production Compose gives every service only its required secrets", async () => {
  const appCompose = await readFile(path.join(repositoryRoot, "compose.app.yml"), "utf8");
  const infraCompose = await readFile(path.join(repositoryRoot, "compose.infra.yml"), "utf8");
  assert.doesNotMatch(appCompose, /^\s+env_file:/m);
  assert.doesNotMatch(infraCompose, /^\s+env_file:/m);

  const service = (name: string): string => {
    const block = appCompose.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9_-]*:\\n|^volumes:)`, "m"))?.[1];
    assert.ok(block, `compose.app.yml must declare the ${name} service`);
    return block;
  };
  const registry = service("registry");
  const runtime = service("runtime");
  const dashboard = service("dashboard");

  assert.match(registry, /HATCH_REGISTRY_DATABASE_URL:/);
  assert.match(registry, /HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN:/);
  assert.match(registry, /HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN:/);
  assert.match(registry, /HATCH_REGISTRY_COMMERCE_SERVICE_TOKEN:/);

  assert.match(runtime, /HATCH_RUNTIME_DATABASE_URL:/);
  assert.match(runtime, /HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN:/);
  assert.doesNotMatch(runtime, /HATCH_REGISTRY_DATABASE_URL:/);
  assert.doesNotMatch(runtime, /HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN:/);
  assert.doesNotMatch(runtime, /HATCH_REGISTRY_COMMERCE_SERVICE_TOKEN:/);
  assert.doesNotMatch(runtime, /POSTGRES_PASSWORD:/);

  assert.match(dashboard, /HATCH_REGISTRY_COMMERCE_SERVICE_TOKEN:/);
  assert.doesNotMatch(dashboard, /HATCH_REGISTRY_DATABASE_URL:/);
  assert.doesNotMatch(dashboard, /HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN:/);
  assert.doesNotMatch(dashboard, /HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN:/);
  assert.doesNotMatch(dashboard, /POSTGRES_PASSWORD:/);

  const postgres = infraCompose.match(/^  postgres:\n([\s\S]*?)(?=^  [a-z][a-z0-9_-]*:\n|^volumes:)/m)?.[1];
  assert.ok(postgres, "compose.infra.yml must declare the Postgres service");
  assert.match(postgres, /POSTGRES_PASSWORD:/);
  assert.doesNotMatch(postgres, /HATCH_REGISTRY_(?:PUBLISH|RUNTIME|COMMERCE)_SERVICE_TOKEN:/);
  assert.doesNotMatch(postgres, /(?:LLM|DEEPSEEK|DASHSCOPE)_API_KEY:/);
});
