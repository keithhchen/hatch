import { createHash, randomBytes } from "node:crypto";

const b64url = (buf) => buf.toString("base64url");

export const challengeFor = (verifier) => b64url(createHash("sha256").update(verifier).digest());

export function createPkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: challengeFor(verifier) };
}

export const randomState = () => b64url(randomBytes(16));
