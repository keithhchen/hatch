import assert from "node:assert/strict";
import test from "node:test";
import {
  SandboxProviderAdapter,
  createProviderAdapter,
  signSandboxWebhook
} from "../providerAdapters.mjs";

test("sandbox payout provider is deterministic", async () => {
  const provider = new SandboxProviderAdapter({ webhookSecret: "sandbox-secret" });
  const input = { payout_id: "payout_1", attempt: 1 };
  assert.deepEqual(await provider.createPayout(input), await provider.createPayout(input));
  assert.equal((await provider.createPayout(input)).status, "in_transit");
});

test("signed provider webhook verifies raw bytes and rejects tampering", () => {
  const provider = new SandboxProviderAdapter({ webhookSecret: "sandbox-secret" });
  const { rawBody, signature } = signSandboxWebhook({ provider_event_id: "evt_1", status: "succeeded" }, "sandbox-secret");
  assert.equal(provider.verifyWebhook(rawBody, { "x-hatch-provider-signature": signature }).provider_event_id, "evt_1");
  assert.throws(
    () => provider.verifyWebhook(Buffer.from(`${rawBody} `), { "x-hatch-provider-signature": signature }),
    (error) => error.code === "invalid_webhook_signature"
  );
});

test("provider selection fails closed in production and when disabled", async () => {
  assert.throws(
    () => createProviderAdapter({ mode: "sandbox", production: true }),
    /cannot run in production/
  );
  const providerOptions = {
    mode: "provider",
    production: true,
    baseUrl: "https://provider.example",
    apiToken: "provider-token",
    webhookSecret: "provider-webhook-secret"
  };
  assert.throws(
    () => createProviderAdapter(providerOptions),
    /PAID_LAUNCH_APPROVED=true/
  );
  assert.equal(createProviderAdapter({ ...providerOptions, paidLaunchApproved: true }).mode, "provider");
  await assert.rejects(
    createProviderAdapter({ mode: "disabled" }).createPayout({}),
    (error) => error.code === "payout_provider_unavailable"
  );
});
