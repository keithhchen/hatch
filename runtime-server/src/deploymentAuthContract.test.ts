import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(process.cwd(), "..");

test("production routes logout to Registry and disables legacy HMAC auth", async () => {
  const caddyfile = await readFile(path.join(repositoryRoot, "Caddyfile"), "utf8");
  const registryMatcher = caddyfile.match(/^\s*@registry_api path ([^\n]+)$/m)?.[1];
  assert.ok(registryMatcher, "Caddyfile must declare the Registry API matcher");
  assert.match(registryMatcher, /(?:^|\s)\/v1\/auth\/logout(?:\s|$)/);

  const deployWorkflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "deploy.yml"),
    "utf8"
  );
  const requiredKeys = deployWorkflow.match(/for key in ([^;\n]+); do/)?.[1];
  assert.ok(requiredKeys, "deploy workflow must validate production secrets");
  assert.doesNotMatch(requiredKeys, /HATCH_AUTH_SIGNING_SECRET/);
});
