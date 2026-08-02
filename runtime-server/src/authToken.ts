import { createHmac, timingSafeEqual } from "node:crypto";

export type HatchAuthClaims = {
  sub: string;
  role: "user" | "creator";
  exp: number;
};

/** Verify the small stateless token issued by Platform Registry. */
export function verifyHatchAuthToken(
  token: string | undefined,
  secret = process.env.HATCH_AUTH_SIGNING_SECRET?.trim()
): HatchAuthClaims | undefined {
  if (!token || !secret) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const expected = base64url(createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest());
  const supplied = Buffer.from(parts[2] ?? "");
  const expectedBytes = Buffer.from(expected);
  if (supplied.length !== expectedBytes.length || !timingSafeEqual(supplied, expectedBytes)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof payload.sub !== "string" || !payload.sub || (payload.role !== "user" && payload.role !== "creator")) return undefined;
    if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return undefined;
    return { sub: payload.sub, role: payload.role, exp: payload.exp };
  } catch {
    return undefined;
  }
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}
