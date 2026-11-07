import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Credentials an Expert gives us are stored sealed. Without a key, the feature is off rather than stored in the clear. */
export class CredentialSeal {
  private key: Buffer;
  constructor(secret: string) { this.key = createHash("sha256").update(secret).digest(); }
  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }
  open<T>(sealed: string): T {
    const bytes = Buffer.from(sealed, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")) as T;
  }
}
