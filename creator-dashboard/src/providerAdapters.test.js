import assert from "node:assert/strict";
import test from "node:test";
import {
  SandboxProviderAdapter,
  createProviderAdapter,
  signSandboxWebhook
} from "../providerAdapters.mjs";

test("sandbox provider is deterministic and supports requires-action without granting access", async () => {
  const provider = new SandboxProviderAdapter({ webhookSecret: "sandbox-secret", scenario: "requires_action" });
  const first = await provider.createPayment({ payment_id: "payment_1", checkout_session_id: "checkout_1" });
  const replay = await provider.createPayment({ payment_id: "payment_1", checkout_session_id: "checkout_1" });
  assert.deepEqual(replay, first);
  assert.equal(first.status, "requires_action");
  assert.match(first.redirect_url, /checkout_1/);
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
    createProviderAdapter({ mode: "disabled" }).createPayment({}),
    (error) => error.code === "payment_provider_unavailable"
  );
});
