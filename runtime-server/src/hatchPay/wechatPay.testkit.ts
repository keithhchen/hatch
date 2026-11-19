import { createCipheriv, createPublicKey, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PLATFORM_CERT_PEM, PLATFORM_CERT_SERIAL, PLATFORM_KEY_PEM } from "./wechatPay.testcert.js";
import type { WeChatPayConfig } from "./wechatPay.js";

export const API_V3_KEY = "0123456789abcdef0123456789abcdef";
export const PUBLIC_KEY_ID = "PUB_KEY_ID_TEST";
export { PLATFORM_CERT_PEM, PLATFORM_CERT_SERIAL };

const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
export const freshKeyPair = rsa;

/** The merchant's own key is made per test; WeChat's (the platform) is the fixture certificate's, so a fake WeChat server can sign with it. */
export function testKeys() {
  const merchant = rsa();
  const platformPublicPem = createPublicKey(PLATFORM_CERT_PEM).export({ type: "spki", format: "pem" }).toString();
  const base = {
    mchid: "1639838957", appid: "wxtestappid", serial: "MERCHANTSERIAL", privateKeyPem: merchant.privateKey, apiV3Key: API_V3_KEY,
    notifyUrl: "https://gethatchapp.com/hatch-pay/notify"
  };
  /** Public-key mode: WeChat signs under PUB_KEY_ID_TEST. */
  const config: WeChatPayConfig = { ...base, publicKeyId: PUBLIC_KEY_ID, publicKeyPem: platformPublicPem };
  /** Certificate mode: no public key; WeChat signs under the certificate's serial. */
  const certificateConfig: WeChatPayConfig = { ...base };
  return { config, certificateConfig, merchantPublicPem: merchant.publicKey, platformPrivatePem: PLATFORM_KEY_PEM };
}

/** AEAD_AES_256_GCM as WeChat does it: the auth tag is the last 16 bytes of the ciphertext. */
export function encryptResource(plaintext: string, associated = "transaction") {
  const nonce = randomBytes(6).toString("hex");
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(API_V3_KEY), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associated));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { algorithm: "AEAD_AES_256_GCM", ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"), nonce, associated_data: associated };
}

const sign = (privatePem: string, timestamp: string, nonce: string, body: string) => createSign("RSA-SHA256").update(`${timestamp}\n${nonce}\n${body}\n`).sign(privatePem, "base64");

/** What WeChat sends to notify_url: the transaction encrypted with the APIv3 key, the whole body signed with the platform key. */
export function signedNotification(options: { platformPrivatePem: string; serial?: string; timestamp?: number; transaction: Record<string, unknown> }) {
  const nonce = randomBytes(6).toString("hex");
  const body = JSON.stringify({ id: "evt", event_type: "TRANSACTION.SUCCESS", resource_type: "encrypt-resource", resource: encryptResource(JSON.stringify(options.transaction)) });
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  return { body, headers: { "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce, "wechatpay-signature": sign(options.platformPrivatePem, timestamp, nonce, body), "wechatpay-serial": options.serial ?? PUBLIC_KEY_ID } };
}

/** The body of GET /v3/certificates: each certificate encrypted with the APIv3 key, its serial in the clear. */
export const certificatesBody = (certificates: Array<{ serial: string; pem: string }>) => ({
  data: certificates.map(c => ({ serial_no: c.serial, effective_time: "2026-01-01T00:00:00+08:00", expire_time: "2028-01-01T00:00:00+08:00", encrypt_certificate: encryptResource(c.pem, "certificate") }))
});

export type FakeRequest = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

/**
 * A WeChat stand-in for tests: records requests, answers from `respond`, and signs every answer (as WeChat does) under `serial`,
 * unless `serial` is null. The answer of /v3/certificates is signed by nobody the client knows yet; WeChat's real one is signed too, and ignored.
 */
export async function fakeWeChat(respond: (request: FakeRequest) => { status?: number; body: unknown }, options: { serial?: string | null; platformPrivatePem?: string } = {}) {
  const requests: FakeRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
    requests.push(request);
    const answer = respond(request);
    const text = JSON.stringify(answer.body);
    const headers: Record<string, string> = { "content-type": "application/json", "request-id": `req-${requests.length}` };
    if (options.serial !== null) {
      const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(8).toString("hex");
      Object.assign(headers, { "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce, "wechatpay-serial": options.serial ?? PUBLIC_KEY_ID, "wechatpay-signature": sign(options.platformPrivatePem ?? PLATFORM_KEY_PEM, timestamp, nonce, text) });
    }
    res.writeHead(answer.status ?? 200, headers);
    res.end(text);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
