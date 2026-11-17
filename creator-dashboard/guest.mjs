import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "hatch_guest.";

/**
 * A guest is a browser that has not signed in. Its id travels as a signed token `hatch_guest.<id>.<signature>` that the Runtime
 * verifies with the same shared secret (runtime-server/src/guestToken.ts); the two implementations share a test vector.
 */
export function createGuestTokens(secret) {
  if (!String(secret ?? "").trim()) throw new Error("Guest tokens need a signing secret");
  const key = createHmac("sha256", secret).update("hatch-guest-token-v1").digest();
  const sign = (id) => createHmac("sha256", key).update(id).digest("base64url");
  const issue = (id) => `${PREFIX}${id}.${sign(id)}`;
  return {
    issue,
    mint: () => issue(randomBytes(16).toString("base64url")),
    verify(token) {
      if (typeof token !== "string" || !token.startsWith(PREFIX)) return false;
      const [id, signature, ...rest] = token.slice(PREFIX.length).split(".");
      if (!id || !signature || rest.length || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return false;
      const expected = Buffer.from(sign(id));
      const supplied = Buffer.from(signature);
      return expected.length === supplied.length && timingSafeEqual(expected, supplied);
    }
  };
}
