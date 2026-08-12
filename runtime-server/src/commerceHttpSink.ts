import type { CommerceEventSink, CommerceEventType } from "./delivery.js";

/** Runtime client for the Dashboard's authenticated internal Commerce API. */
export class HttpCommerceEventSink implements CommerceEventSink {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (!baseUrl.trim() || !serviceToken.trim()) throw new Error("Commerce URL and Runtime service token are required");
  }

  async append(
    type: CommerceEventType,
    payload: Record<string, unknown>,
    options: { idempotencyKey: string }
  ): Promise<unknown> {
    return this.request("/v1/internal/commerce/events", {
      method: "POST",
      idempotencyKey: options.idempotencyKey,
      body: { type, payload }
    });
  }

  async findByIdempotencyKey(key: string): Promise<unknown> {
    const response = await this.fetchImpl(this.url(`/v1/internal/commerce/idempotency/${encodeURIComponent(key)}`), {
      headers: this.headers()
    });
    if (response.status === 404) return undefined;
    const payload = await responsePayload(response);
    if (!response.ok) throw commerceHttpError(response.status, payload);
    return record(payload).event;
  }

  async getEntitlement(entitlementId: string): Promise<unknown> {
    const response = await this.fetchImpl(this.url(
      `/v1/internal/commerce/entitlements/${encodeURIComponent(entitlementId)}`
    ), { headers: this.headers() });
    const payload = await responsePayload(response);
    if (!response.ok) throw commerceHttpError(response.status, payload);
    return record(payload).entitlement;
  }

  async checkReady(): Promise<void> {
    const dashboard = await this.fetchImpl(this.url("/readyz"), {
      headers: this.headers(),
      signal: AbortSignal.timeout(5_000)
    });
    const dashboardPayload = await responsePayload(dashboard);
    if (!dashboard.ok) throw commerceHttpError(dashboard.status, dashboardPayload);

    const internal = await this.fetchImpl(this.url("/v1/internal/commerce/idempotency/runtime%3Areadiness"), {
      headers: this.headers(),
      signal: AbortSignal.timeout(5_000)
    });
    if (internal.status === 404) return;
    const internalPayload = await responsePayload(internal);
    if (!internal.ok) throw commerceHttpError(internal.status, internalPayload);
  }

  async authorizeAndReserve(
    input: Parameters<NonNullable<CommerceEventSink["authorizeAndReserve"]>>[0],
    options: { idempotencyKey: string }
  ): Promise<unknown> {
    return this.request("/v1/internal/commerce/reservations", {
      method: "POST",
      idempotencyKey: options.idempotencyKey,
      body: input
    });
  }

  async advanceEntitlementVersion(
    input: Parameters<NonNullable<CommerceEventSink["advanceEntitlementVersion"]>>[0],
    options: { idempotencyKey: string }
  ): Promise<unknown> {
    return this.request(
      `/v1/internal/commerce/entitlements/${encodeURIComponent(input.entitlement_id)}/advance-version`,
      {
        method: "POST",
        idempotencyKey: options.idempotencyKey,
        body: {
          from_digest: input.from_digest,
          to_digest: input.to_digest,
          ...(input.from_release_id ? { from_release_id: input.from_release_id } : {}),
          ...(input.to_release_id ? { to_release_id: input.to_release_id } : {}),
          compatibility_declaration_id: input.compatibility_declaration_id,
          reason: input.reason
        }
      }
    );
  }

  async releaseReservation(
    input: Parameters<NonNullable<CommerceEventSink["releaseReservation"]>>[0],
    options: { idempotencyKey: string }
  ): Promise<unknown> {
    return this.request(`/v1/internal/commerce/reservations/${encodeURIComponent(input.reservation_id)}/release`, {
      method: "POST",
      idempotencyKey: options.idempotencyKey,
      body: { reason: input.reason }
    });
  }

  async completeDelivery(
    input: Parameters<NonNullable<CommerceEventSink["completeDelivery"]>>[0],
    options: { idempotencyKey: string }
  ): Promise<unknown> {
    return this.request("/v1/internal/commerce/deliveries", {
      method: "POST",
      idempotencyKey: options.idempotencyKey,
      body: input
    });
  }

  private async request(
    pathname: string,
    input: { method: "POST"; idempotencyKey: string; body: Record<string, unknown> }
  ): Promise<unknown> {
    const response = await this.fetchImpl(this.url(pathname), {
      method: input.method,
      headers: {
        ...this.headers(),
        "content-type": "application/json",
        "idempotency-key": input.idempotencyKey
      },
      body: JSON.stringify(input.body)
    });
    const payload = await responsePayload(response);
    if (!response.ok) throw commerceHttpError(response.status, payload);
    return payload;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.serviceToken}`,
      accept: "application/json"
    };
  }

  private url(pathname: string): string {
    return new URL(pathname, this.baseUrl).toString();
  }
}

async function responsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return {};
  return response.json().catch(() => ({}));
}

function commerceHttpError(status: number, payload: unknown): Error {
  const value = record(payload);
  const nested = record(value.error);
  const code = String(nested.code ?? value.code ?? `commerce_http_${status}`);
  const message = String(nested.message ?? value.detail ?? value.message ?? `Commerce request failed with HTTP ${status}`);
  const error = new Error(message) as Error & { code?: string; status?: number };
  error.code = code;
  error.status = status;
  return error;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
