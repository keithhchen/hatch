import assert from "node:assert/strict";
import test from "node:test";
import {
  OPERATIONAL_FAILURES,
  summarizeOperationalError,
  writeOperationalError,
  type OperationalFailureCode
} from "./operationalLogging.js";

const DENYLIST_FIXTURES: Array<{ label: string; secret: string; error: unknown }> = [
  {
    label: "e-mail",
    secret: "seth-uat@example.com",
    error: new Error("Checkout failed for seth-uat@example.com")
  },
  {
    label: "Authorization header and token",
    secret: "Bearer sk-live-runtime-secret",
    error: { authorization: "Bearer sk-live-runtime-secret", code: "provider_401" }
  },
  {
    label: "Workspace absolute path",
    secret: "/Users/keithchen/private-workspace/customer-a",
    error: new TypeError("Cannot read /Users/keithchen/private-workspace/customer-a")
  },
  {
    label: "artifact absolute path",
    secret: "/var/lib/hatch/artifacts/order-42/private.md",
    error: { artifact_path: "/var/lib/hatch/artifacts/order-42/private.md" }
  },
  {
    label: "prompt/content",
    secret: "CONFIDENTIAL_PROMPT_AND_BUYER_CONTENT",
    error: new Error("Provider rejected CONFIDENTIAL_PROMPT_AND_BUYER_CONTENT")
  },
  {
    label: "provider raw response body",
    secret: "RAW_PROVIDER_BODY_WITH_PII",
    error: { response: { body: "RAW_PROVIDER_BODY_WITH_PII" } }
  },
  {
    label: "stack",
    secret: "/private/runtime/secret-provider-client.ts:91:7",
    error: Object.assign(new Error("provider failed"), {
      stack: "Error: provider failed\n    at /private/runtime/secret-provider-client.ts:91:7"
    })
  }
];

test("operational summaries expose only allowlisted name/code/category fields", () => {
  for (const code of Object.keys(OPERATIONAL_FAILURES) as OperationalFailureCode[]) {
    const summary = summarizeOperationalError(code, new Error("never serialize this message"));
    assert.deepEqual(Object.keys(summary), ["name", "code", "category"]);
    assert.deepEqual(summary, {
      name: "Error",
      code,
      category: OPERATIONAL_FAILURES[code]
    });
  }
});

test("denylist matrix never serializes sensitive exception data", () => {
  for (const fixture of DENYLIST_FIXTURES) {
    let output = "";
    writeOperationalError("runtime_startup_failed", fixture.error, (record) => {
      output += record;
    });

    assert.doesNotMatch(output, new RegExp(escapeRegExp(fixture.secret), "i"), fixture.label);
    assert.doesNotMatch(output, /authorization|bearer|token|workspace|artifact|prompt|content|raw_provider|stack/i, fixture.label);
    assert.deepEqual(JSON.parse(output), {
      name: fixture.error instanceof TypeError ? "TypeError" : fixture.error instanceof Error ? "Error" : "NonError",
      code: "runtime_startup_failed",
      category: "runtime_startup"
    });
  }
});

test("untrusted custom error names fall back to the stable Error name", () => {
  const error = new Error("safe only because messages are ignored");
  error.name = "seth-uat@example.com Bearer secret-token";
  assert.deepEqual(summarizeOperationalError("registry_startup_failed", error), {
    name: "Error",
    code: "registry_startup_failed",
    category: "registry_startup"
  });
});

test("hostile exception accessors cannot break or enrich the summary", () => {
  const error = new Error("ignored");
  Object.defineProperty(error, "name", {
    get() {
      throw new Error("Bearer should-never-escape");
    }
  });
  assert.deepEqual(summarizeOperationalError("creator_factory_worker_failed", error), {
    name: "NonError",
    code: "creator_factory_worker_failed",
    category: "creator_factory_worker"
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
