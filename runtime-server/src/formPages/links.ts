import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The link to a form page is signed for that page and its owner, and never expires: the page is the Expert's own, and
 * the same link is sent to a chat and opened from there for as long as the Expert wants to come back to it.
 */
export class FormLinks {
  private readonly key: Buffer;
  constructor(secret: string, private readonly origin: string) {
    if (!secret.trim()) throw new Error("Form links need a signing secret");
    this.key = createHmac("sha256", secret).update("hatch-form-link-v1").digest();
  }

  token(formId: string, accountId: string): string {
    return createHmac("sha256", this.key).update(`${formId}\n${accountId}`).digest("base64url");
  }

  verify(formId: string, accountId: string, token: string | null | undefined): boolean {
    if (!token) return false;
    const expected = Buffer.from(this.token(formId, accountId));
    const supplied = Buffer.from(token);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }

  url(formId: string, accountId: string): string {
    return `${this.origin}/f/${formId}?t=${this.token(formId, accountId)}`;
  }
}
