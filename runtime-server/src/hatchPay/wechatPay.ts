import { createDecipheriv, createPrivateKey, createPublicKey, randomBytes, createSign, createVerify, type KeyObject } from "node:crypto";
import { log as appLog } from "../observability/log.js";

/** What the pay flow needs from WeChat Pay (API v3). The adapter below talks to the real API; tests give it a fake WeChat server's URL. */
export interface WeChatPay {
  /** False until the keys that verify WeChat's signatures are loaded: the pay routes answer 503 meanwhile. */
  ready(): boolean;
  createH5Order(order: OrderInput & { payerIp: string }): Promise<{ h5Url: string }>;
  createJsapiOrder(order: OrderInput & { openid: string }): Promise<{ prepayId: string }>;
  queryOrder(outTradeNo: string): Promise<OrderState>;
  /** The parameters of `WeixinJSBridge.invoke('getBrandWCPayRequest', …)`, signed for this prepay id. */
  jsapiInvokeParams(prepayId: string): JsapiInvokeParams;
  /** Throws NotificationRejected unless the request really is WeChat's; returns the paid transaction. */
  readNotification(headers: Record<string, string | undefined>, body: string): Promise<OrderState>;
}

export type OrderInput = { outTradeNo: string; description: string; amountFen: number; expiresAt: Date; /** Comes back in the query and the notification (WeChat allows 128 characters). */ attach?: string };
export type OrderState = { tradeState: string; outTradeNo: string; transactionId?: string; amountFen?: number; mchid?: string; attach?: string };
export type JsapiInvokeParams = { appId: string; timeStamp: string; nonceStr: string; package: string; signType: "RSA"; paySign: string };

/** WeChat signs with either a WeChat Pay public key (id + key given) or platform certificates fetched with the APIv3 key (neither given). */
export type WeChatPayConfig = {
  mchid: string;
  appid: string;
  serial: string;
  privateKeyPem: string;
  apiV3Key: string;
  publicKeyId?: string;
  publicKeyPem?: string;
  notifyUrl: string;
};

export class WeChatPayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId: string | null) {
    super(`WeChat Pay ${status} ${code}: ${message}`);
  }
}
export class NotificationRejected extends Error {}

type Log = (entry: Record<string, unknown>) => void;
const DEFAULT_HOSTS = ["https://api.mch.weixin.qq.com", "https://api2.mch.weixin.qq.com"];
const SIGNATURE_MAX_AGE_S = 5 * 60;
const CERTIFICATES_PATH = "/v3/certificates";

/** The documented signature message: each line ends with a newline, the body line too (empty for GET). */
export const requestMessage = (method: string, pathAndQuery: string, timestamp: string, nonce: string, body: string) => `${method}\n${pathAndQuery}\n${timestamp}\n${nonce}\n${body}\n`;
const rsaSign = (key: KeyObject, message: string) => createSign("RSA-SHA256").update(message).sign(key, "base64");

/** RFC 3339 with the +08:00 offset WeChat documents. */
export function rfc3339Beijing(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 19);
  return `${shifted}+08:00`;
}

/** The key that verifies a signature, by the serial in `Wechatpay-Serial`. */
export interface VerifierKeys {
  ready(): boolean;
  keyFor(serial: string): Promise<KeyObject | undefined>;
}

class PublicKeyVerifier implements VerifierKeys {
  constructor(private readonly id: string, private readonly key: KeyObject) {}
  ready() { return true; }
  async keyFor(serial: string) { return serial === this.id ? this.key : undefined; }
}

/**
 * Platform certificates, cached by serial. An unknown serial refetches once (at most once per cooldown); the whole set is refreshed
 * every 12 hours by the owner of this object.
 */
export class PlatformCertificates implements VerifierKeys {
  private readonly certificates = new Map<string, KeyObject>();
  private lastAttempt = Number.NEGATIVE_INFINITY;
  constructor(private readonly fetchAll: () => Promise<Array<{ serial: string; pem: string }>>, private readonly cooldownMs = 30_000, private readonly now: () => number = Date.now) {}

  ready() { return this.certificates.size > 0; }

  async load(): Promise<void> {
    this.lastAttempt = this.now();
    const fetched = await this.fetchAll();
    if (!fetched.length) throw new Error("WeChat Pay returned no platform certificates.");
    this.certificates.clear();
    for (const { serial, pem } of fetched) this.certificates.set(serial, createPublicKey(pem));
  }

  async keyFor(serial: string): Promise<KeyObject | undefined> {
    const known = this.certificates.get(serial);
    if (known || this.now() - this.lastAttempt < this.cooldownMs) return known;
    await this.load().catch(error => appLog.warn("wechatpay_certificates_refetch_failed", { error }));
    return this.certificates.get(serial);
  }
}

export class WeChatPayV3 implements WeChatPay {
  private readonly privateKey: KeyObject;
  private readonly verifier: VerifierKeys;
  private readonly certificates?: PlatformCertificates;

  /** `hosts`: the primary first, then the backup, tried in turn only when a request fails before WeChat answers. */
  constructor(
    private readonly config: WeChatPayConfig,
    private readonly options: { hosts?: string[]; log?: Log; fetch?: typeof fetch; now?: () => Date; timeoutMs?: number; certificateCooldownMs?: number } = {}
  ) {
    if (Buffer.byteLength(config.apiV3Key) !== 32) throw new Error("WECHATPAY_APIV3_KEY must be 32 bytes.");
    if (!config.publicKeyId !== !config.publicKeyPem) throw new Error("WeChat Pay public key id and key go together.");
    this.privateKey = createPrivateKey(config.privateKeyPem);
    if (config.publicKeyId && config.publicKeyPem) this.verifier = new PublicKeyVerifier(config.publicKeyId, createPublicKey(config.publicKeyPem));
    else this.verifier = this.certificates = new PlatformCertificates(() => this.fetchCertificates(), options.certificateCooldownMs, () => this.now.getTime());
  }

  private get log(): Log { return this.options.log ?? (entry => appLog.info("wechatpay_request", entry)); }
  private get now() { return this.options.now?.() ?? new Date(); }

  ready() { return this.verifier.ready(); }

  /**
   * Certificate mode: fetch until it works (a transient failure at startup must not stop the Runtime), then every 12 hours.
   * Timers never keep the process alive. A no-op with a public key.
   */
  start(options: { retryMs?: number; refreshMs?: number } = {}): void {
    const certificates = this.certificates;
    if (!certificates) return;
    const retryMs = options.retryMs ?? 10_000;
    const attempt = () => certificates.load().then(
      () => appLog.info("wechatpay_certificates_loaded", {}),
      error => { appLog.warn("wechatpay_certificates_failed", { error }); setTimeout(attempt, retryMs).unref(); }
    );
    void attempt();
    setInterval(() => void certificates.load().catch(error => appLog.warn("wechatpay_certificates_refresh_failed", { error })), options.refreshMs ?? 12 * 3600_000).unref();
  }

  /** GET /v3/certificates. Its response cannot be verified (the certificates are what it delivers); the APIv3 key decrypting them is the check. */
  async fetchCertificates(): Promise<Array<{ serial: string; pem: string }>> {
    const body = await this.call("GET", CERTIFICATES_PATH, undefined, { verify: false });
    const entries = (body.data ?? []) as Array<{ serial_no: string; encrypt_certificate: { ciphertext: string; nonce: string; associated_data?: string } }>;
    return entries.map(entry => ({ serial: entry.serial_no, pem: decryptResource(this.config.apiV3Key, entry.encrypt_certificate) }));
  }

  createH5Order(order: OrderInput & { payerIp: string }) {
    return this.createOrder("h5", order, { scene_info: { payer_client_ip: order.payerIp, h5_info: { type: "Wap" } } })
      .then(body => ({ h5Url: String(body.h5_url) }));
  }

  createJsapiOrder(order: OrderInput & { openid: string }) {
    return this.createOrder("jsapi", order, { payer: { openid: order.openid } })
      .then(body => ({ prepayId: String(body.prepay_id) }));
  }

  private createOrder(kind: "h5" | "jsapi", order: OrderInput, extra: Record<string, unknown>) {
    return this.call("POST", `/v3/pay/transactions/${kind}`, {
      appid: this.config.appid, mchid: this.config.mchid, description: order.description, out_trade_no: order.outTradeNo,
      time_expire: rfc3339Beijing(order.expiresAt), notify_url: this.config.notifyUrl,
      amount: { total: order.amountFen, currency: "CNY" }, ...order.attach ? { attach: order.attach } : {}, ...extra
    });
  }

  async queryOrder(outTradeNo: string): Promise<OrderState> {
    try {
      return stateOf(await this.call("GET", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${this.config.mchid}`));
    } catch (error) {
      // WeChat only knows an order once creating it was accepted: unknown is not paid, not an outage.
      if (error instanceof WeChatPayError && error.code === "ORDER_NOT_EXIST") return { tradeState: "NOTFOUND", outTradeNo };
      throw error;
    }
  }

  jsapiInvokeParams(prepayId: string): JsapiInvokeParams {
    const timeStamp = String(Math.floor(this.now.getTime() / 1000)), nonceStr = randomBytes(16).toString("hex"), pkg = `prepay_id=${prepayId}`;
    const paySign = rsaSign(this.privateKey, `${this.config.appid}\n${timeStamp}\n${nonceStr}\n${pkg}\n`);
    return { appId: this.config.appid, timeStamp, nonceStr, package: pkg, signType: "RSA", paySign };
  }

  /** WeChat's signature over `timestamp\nnonce\nbody\n`, by the key of the serial it names. Used for callbacks and responses alike. */
  private async verify(headers: Record<string, string | undefined>, body: string): Promise<void> {
    const signature = headers["wechatpay-signature"], serial = headers["wechatpay-serial"];
    const timestamp = headers["wechatpay-timestamp"], nonce = headers["wechatpay-nonce"];
    if (!signature || !serial || !timestamp || !nonce) throw new NotificationRejected("missing signature headers");
    // WeChat's own probe: signed with a throwaway key so that a verifier that accepts it is broken.
    if (signature.startsWith("WECHATPAY/SIGNTEST/")) throw new NotificationRejected("signature probe");
    const key = await this.verifier.keyFor(serial);
    if (!key) throw new NotificationRejected(`unknown serial ${serial}`);
    if (Math.abs(this.now.getTime() / 1000 - Number(timestamp)) > SIGNATURE_MAX_AGE_S) throw new NotificationRejected("stale timestamp");
    if (!createVerify("RSA-SHA256").update(`${timestamp}\n${nonce}\n${body}\n`).verify(key, signature, "base64")) throw new NotificationRejected("bad signature");
  }

  async readNotification(headers: Record<string, string | undefined>, body: string): Promise<OrderState> {
    await this.verify(headers, body);
    let envelope: { event_type?: string; resource?: { algorithm?: string; ciphertext: string; nonce: string; associated_data?: string } };
    try { envelope = JSON.parse(body); } catch { throw new NotificationRejected("body is not JSON"); }
    if (!envelope.resource || envelope.resource.algorithm !== "AEAD_AES_256_GCM") throw new NotificationRejected("no AEAD_AES_256_GCM resource");
    let resource: Record<string, unknown>;
    try { resource = JSON.parse(decryptResource(this.config.apiV3Key, envelope.resource)); } catch { throw new NotificationRejected("resource does not decrypt"); }
    return stateOf(resource);
  }

  /** One signed request. Transport failures move to the next host; any answer from WeChat, error or not, is final. */
  private async call(method: "GET" | "POST", pathAndQuery: string, payload?: unknown, options: { verify?: boolean } = {}): Promise<Record<string, unknown>> {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const doFetch = this.options.fetch ?? fetch;
    let lastFailure: unknown;
    for (const host of this.options.hosts ?? DEFAULT_HOSTS) {
      const timestamp = String(Math.floor(this.now.getTime() / 1000)), nonce = randomBytes(16).toString("hex");
      const signature = rsaSign(this.privateKey, requestMessage(method, pathAndQuery, timestamp, nonce, body));
      const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${this.config.serial}"`;
      let response: Response;
      try {
        response = await doFetch(`${host}${pathAndQuery}`, {
          method, ...body ? { body } : {}, signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
          // Node's default Accept-Language is one WeChat rejects (406 PARAM_ERROR).
          headers: { authorization, accept: "application/json", "content-type": "application/json", "accept-language": "zh-CN", "user-agent": "hatch-runtime/wechatpay" }
        });
      } catch (error) {
        this.log({ host, method, path: pathAndQuery.split("?")[0], transportError: error instanceof Error ? error.message : String(error) });
        lastFailure = error;
        continue;
      }
      const requestId = response.headers.get("request-id");
      this.log({ host, method, path: pathAndQuery.split("?")[0], status: response.status, requestId });
      const text = await response.text();
      let parsed: Record<string, unknown> = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { /* kept empty: reported below */ }
      if (response.status >= 200 && response.status < 300) {
        if (options.verify !== false) {
          const headers: Record<string, string | undefined> = {};
          for (const name of ["wechatpay-signature", "wechatpay-serial", "wechatpay-timestamp", "wechatpay-nonce"]) headers[name] = response.headers.get(name) ?? undefined;
          try { await this.verify(headers, text); } catch (error) {
            if (error instanceof NotificationRejected) throw new Error(`WeChat Pay response rejected (${error.message}), request-id ${requestId}`);
            throw error;
          }
        }
        return parsed;
      }
      throw new WeChatPayError(response.status, String(parsed.code ?? "UNKNOWN"), String(parsed.message ?? text.slice(0, 200)), requestId);
    }
    throw new Error(`WeChat Pay unreachable: ${lastFailure instanceof Error ? lastFailure.message : String(lastFailure)}`);
  }
}

const stateOf = (body: Record<string, unknown>): OrderState => {
  const amount = body.amount as { total?: number } | undefined;
  return {
    tradeState: String(body.trade_state ?? ""), outTradeNo: String(body.out_trade_no ?? ""),
    ...body.transaction_id ? { transactionId: String(body.transaction_id) } : {},
    ...typeof amount?.total === "number" ? { amountFen: amount.total } : {},
    ...body.mchid ? { mchid: String(body.mchid) } : {},
    ...body.attach ? { attach: String(body.attach) } : {}
  };
};

/** AEAD_AES_256_GCM: the last 16 bytes of the ciphertext are the auth tag. */
export function decryptResource(apiV3Key: string, resource: { ciphertext: string; nonce: string; associated_data?: string }): string {
  const data = Buffer.from(resource.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(resource.nonce));
  decipher.setAuthTag(data.subarray(data.length - 16));
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8");
}
