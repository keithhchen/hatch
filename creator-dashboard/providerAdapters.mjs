import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Provider-neutral payout bridge used by the Dashboard BFF (creator payouts only). Production integrations
 * implement this small JSON contract outside the Commerce domain; tests and
 * local UAT use the deterministic sandbox adapter. No card/bank details enter
 * Hatch or its event stream.
 */
export function createProviderAdapter(options = {}) {
  if (options.adapter) return options.adapter;
  const mode = options.mode ?? "disabled";
  if (mode === "sandbox" || mode === "test") {
    if (options.production && options.allowSandboxInProduction !== true) {
      throw new Error("The sandbox payment provider cannot run in production");
    }
    return new SandboxProviderAdapter({
      webhookSecret: options.webhookSecret ?? "hatch-local-sandbox-webhook"
    });
  }
  if (mode === "provider") {
    if (options.production && options.paidLaunchApproved !== true) {
      throw new Error("Provider mode requires HATCH_COMMERCE_PAID_LAUNCH_APPROVED=true after payment, tax, region, refund, and payout policy approval");
    }
    return new HttpProviderAdapter({
      baseUrl: options.baseUrl,
      apiToken: options.apiToken,
      webhookSecret: options.webhookSecret,
      fetchImpl: options.fetchImpl
    });
  }
  return new DisabledProviderAdapter();
}

export class DisabledProviderAdapter {
  mode = "disabled";
  configured = false;
  async createPayoutAccountSession() { throw providerError("payout_provider_unavailable", "Payout onboarding is not configured.", 409); }
  async createPayout() { throw providerError("payout_provider_unavailable", "Payouts are not configured.", 409); }
  async retrievePayout() { throw providerError("payout_provider_unavailable", "Payouts are not configured.", 409); }
  verifyWebhook() { throw providerError("webhook_provider_unavailable", "Provider webhooks are not configured.", 404); }
}

export class SandboxProviderAdapter {
  mode = "sandbox";
  configured = true;

  constructor(options = {}) {
    this.webhookSecret = String(options.webhookSecret);
  }

  async createPayoutAccountSession(input) {
    return {
      provider: "hatch_sandbox",
      account_id: stableProviderId("sandbox_account", input.creator_id),
      account_status: "active",
      session_url: "/portal/creator/settings/payouts?setup=complete",
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString()
    };
  }

  async createPayout(input) {
    const providerPayoutId = input.provider_payout_id
      ?? stableProviderId("sandbox_payout", `${input.payout_id}:${input.attempt ?? 1}`);
    return {
      provider: "hatch_sandbox",
      provider_payout_id: providerPayoutId,
      provider_event_id: `${providerPayoutId}:submitted`,
      status: "in_transit"
    };
  }

  async retrievePayout(input) {
    return {
      provider: "hatch_sandbox",
      provider_payout_id: input.provider_payout_id,
      provider_event_id: `${input.provider_payout_id}:status:in_transit`,
      status: "in_transit"
    };
  }

  verifyWebhook(rawBody, headers) {
    return verifySignedPayload(rawBody, headers, this.webhookSecret);
  }
}

export class HttpProviderAdapter {
  mode = "provider";
  configured = true;

  constructor(options = {}) {
    if (!options.baseUrl || !options.apiToken || !options.webhookSecret) {
      throw new Error("Provider mode requires baseUrl, apiToken, and webhookSecret");
    }
    this.baseUrl = new URL(options.baseUrl);
    this.apiToken = String(options.apiToken);
    this.webhookSecret = String(options.webhookSecret);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  createPayoutAccountSession(input) { return this.#command("/v1/payout-account-sessions", input); }
  createPayout(input) { return this.#command("/v1/payouts", input); }
  retrievePayout(input) {
    return this.#request("GET", `/v1/payouts/${encodeURIComponent(input.provider_payout_id)}`, input);
  }
  verifyWebhook(rawBody, headers) { return verifySignedPayload(rawBody, headers, this.webhookSecret); }

  async #command(pathname, input) {
    return this.#request("POST", pathname, input);
  }

  async #request(method, pathname, input) {
    const response = await this.fetchImpl(new URL(pathname, this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        "content-type": "application/json",
        "idempotency-key": String(input.idempotency_key)
      },
      body: method === "GET" ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(10_000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw providerError(
        providerFailureCode(response.status),
        providerFailureMessage(response.status),
        response.status >= 500 ? 503 : 409
      );
    }
    return body;
  }
}

export function verifySignedPayload(rawBody, headers, secret, options = {}) {
  const signature = String(headerValue(headers, "x-hatch-provider-signature") ?? "");
  const parts = Object.fromEntries(signature.split(",").map((part) => part.trim().split("=", 2)));
  const timestamp = Number(parts.t);
  const supplied = parts.v1;
  if (!Number.isSafeInteger(timestamp) || !supplied || !/^[a-f0-9]{64}$/i.test(supplied)) {
    throw providerError("invalid_webhook_signature", "Webhook signature is invalid.", 400);
  }
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > Number(options.toleranceSeconds ?? 300)) {
    throw providerError("expired_webhook_signature", "Webhook signature timestamp is outside the allowed window.", 400);
  }
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(payload).digest("hex");
  if (!safeEqual(expected, supplied)) {
    throw providerError("invalid_webhook_signature", "Webhook signature is invalid.", 400);
  }
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    throw providerError("invalid_webhook_payload", "Webhook payload must be valid JSON.", 400);
  }
}

export function signSandboxWebhook(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return { rawBody, signature: `t=${timestamp},v1=${signature}` };
}

function stableProviderId(prefix, value) {
  return `${prefix}_${createHash("sha256").update(`${prefix}\0${value}`).digest("hex").slice(0, 24)}`;
}

function headerValue(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  const found = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function providerError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function providerFailureCode(status) {
  return status >= 500 ? "provider_temporarily_unavailable" : "provider_request_rejected";
}

function providerFailureMessage(status) {
  return status >= 500
    ? "The provider is temporarily unavailable. Try again."
    : "The provider could not accept this request.";
}
