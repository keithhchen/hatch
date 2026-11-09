import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * WeCom's callback encryption (WXBizMsgCrypt), shared by every WeCom callback: the smart bot and WeChat Customer Service.
 * `receiveId` is the corp id for apps and the empty string for a smart bot.
 */
export class WeComCrypto {
  private key: Buffer;
  constructor(private token: string, encodingAesKey: string, private receiveId = "") {
    this.key = Buffer.from(`${encodingAesKey}=`, "base64");
    if (this.key.length !== 32) throw new Error("EncodingAESKey must be 43 characters");
  }

  /** Signature over the sorted token, timestamp, nonce and ciphertext. */
  sign(timestamp: string, nonce: string, encrypted: string): string {
    return createHash("sha1").update([this.token, timestamp, nonce, encrypted].sort().join("")).digest("hex");
  }

  check(signature: string | null | undefined, timestamp: string, nonce: string, encrypted: string): boolean {
    if (!signature || !this.token) return false;
    const a = Buffer.from(signature); const b = Buffer.from(this.sign(timestamp, nonce, encrypted));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Throws when the ciphertext is not ours: wrong key, truncated, or another receive id. */
  decrypt(encrypted: string): string {
    const decipher = createDecipheriv("aes-256-cbc", this.key, this.key.subarray(0, 16)).setAutoPadding(false);
    const padded = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]);
    const pad = padded.at(-1) ?? 0;
    if (pad < 1 || pad > 32) throw new Error("Bad padding");
    const plain = padded.subarray(0, padded.length - pad);
    const length = plain.readUInt32BE(16);
    const message = plain.subarray(20, 20 + length);
    if (message.length !== length || plain.subarray(20 + length).toString("utf8") !== this.receiveId) throw new Error("Receive id mismatch");
    return message.toString("utf8");
  }

  encrypt(message: string): string {
    const body = Buffer.from(message, "utf8");
    const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
    const plain = Buffer.concat([randomBytes(16), length, body, Buffer.from(this.receiveId, "utf8")]);
    const pad = 32 - (plain.length % 32);
    const cipher = createCipheriv("aes-256-cbc", this.key, this.key.subarray(0, 16)).setAutoPadding(false);
    return Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()]).toString("base64");
  }
}

/** WeCom media is AES-256-CBC with the EncodingAESKey, IV its first 16 bytes, PKCS#7 to 32. */
export function decryptWeComMedia(bytes: Buffer, encodingAesKey: string): Buffer {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16)).setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(bytes), decipher.final()]);
  const pad = padded.at(-1) ?? 0;
  if (pad < 1 || pad > 32) throw new Error("Bad padding");
  return padded.subarray(0, padded.length - pad);
}
