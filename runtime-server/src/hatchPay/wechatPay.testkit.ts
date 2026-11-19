import { createCipheriv, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { WeChatPayConfig } from "./wechatPay.js";

const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });

export const API_V3_KEY = "0123456789abcdef0123456789abcdef";

/** Two RSA keys: the merchant's (signs our requests) and WeChat's (signs notifications), both made for the test. */
export function testKeys() {
  const merchant = pair(), platform = pair();
  const config: WeChatPayConfig = {
    mchid: "1639838957", appid: "wxtestappid", serial: "MERCHANTSERIAL", privateKeyPem: merchant.privateKey, apiV3Key: API_V3_KEY,
    publicKeyId: "PUB_KEY_ID_TEST", publicKeyPem: platform.publicKey, notifyUrl: "https://gethatchapp.com/hatch-pay/notify"
  };
  return { config, merchantPublicPem: merchant.publicKey, platformPrivatePem: platform.privateKey };
}

/** What WeChat sends to notify_url: the transaction encrypted with the APIv3 key, the whole body signed with the platform key. */
export function signedNotification(options: { platformPrivatePem: string; serial?: string; timestamp?: number; transaction: Record<string, unknown> }) {
  const nonce = randomBytes(6).toString("hex"), iv = randomBytes(6).toString("hex"), associated = "transaction";
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(API_V3_KEY), Buffer.from(iv));
  cipher.setAAD(Buffer.from(associated));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(options.transaction), "utf8"), cipher.final()]);
  const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
  const body = JSON.stringify({ id: "evt", event_type: "TRANSACTION.SUCCESS", resource_type: "encrypt-resource", resource: { algorithm: "AEAD_AES_256_GCM", ciphertext, nonce: iv, associated_data: associated } });
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = createSign("RSA-SHA256").update(`${timestamp}\n${nonce}\n${body}\n`).sign(options.platformPrivatePem, "base64");
  return { body, headers: { "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce, "wechatpay-signature": signature, "wechatpay-serial": options.serial ?? "PUB_KEY_ID_TEST" } };
}

export type FakeRequest = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

/** A WeChat stand-in for tests: records requests, answers from `respond`. */
export async function fakeWeChat(respond: (request: FakeRequest) => { status?: number; body: unknown }) {
  const requests: FakeRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
    requests.push(request);
    const answer = respond(request);
    res.writeHead(answer.status ?? 200, { "content-type": "application/json", "request-id": `req-${requests.length}` });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
