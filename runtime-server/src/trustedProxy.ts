import type http from "node:http";
import { BlockList, isIP } from "node:net";

/** Explicit allow-list for the reverse proxies permitted to supply XFF. */
export class TrustedProxyPolicy {
  private readonly blockList = new BlockList();

  constructor(cidrs: string[] = []) {
    for (const cidr of cidrs) this.add(cidr);
  }

  matches(address: string): boolean {
    const normalized = normalizeSourceIp(address);
    const family = isIP(normalized);
    return family !== 0 && this.blockList.check(normalized, family === 4 ? "ipv4" : "ipv6");
  }

  private add(raw: string): void {
    const value = raw.trim();
    const parts = value.split("/");
    if (!value || parts.length > 2) throw new Error(`Invalid trusted proxy CIDR: ${raw}`);
    const address = normalizeSourceIp(parts[0] ?? "");
    const family = isIP(address);
    const maximum = family === 4 ? 32 : family === 6 ? 128 : 0;
    const prefix = parts[1] === undefined ? maximum : Number(parts[1]);
    if (!maximum || !Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
      throw new Error(`Invalid trusted proxy CIDR: ${raw}`);
    }
    this.blockList.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }
}

const NO_TRUSTED_PROXIES = new TrustedProxyPolicy();

export function authTrustedProxyPolicyFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): TrustedProxyPolicy {
  const configured = environment.HATCH_AUTH_TRUSTED_PROXY_CIDRS?.trim();
  return new TrustedProxyPolicy(configured ? configured.split(",") : []);
}

/**
 * X-Forwarded-For is ignored unless the direct peer matches the explicit
 * trusted-proxy allow-list. The rightmost address is the one hop supplied by
 * the deployment proxy.
 */
export function authRequestSourceIp(
  request: http.IncomingMessage,
  trustedProxies: TrustedProxyPolicy = NO_TRUSTED_PROXIES
): string {
  const peer = normalizeSourceIp(request.socket.remoteAddress ?? "");
  if (trustedProxies.matches(peer)) {
    const rawForwarded = request.headers["x-forwarded-for"];
    const forwarded = Array.isArray(rawForwarded) ? rawForwarded.join(",") : rawForwarded;
    if (forwarded) {
      const candidates = forwarded.split(",").map((value) => normalizeSourceIp(value));
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        if (isIP(candidates[index] ?? "")) return candidates[index]!;
      }
    }
  }
  return peer || "unknown";
}

function normalizeSourceIp(value: string): string {
  const normalized = value.trim().replace(/^\[|\]$/g, "").split("%", 1)[0] ?? "";
  if (normalized.toLowerCase().startsWith("::ffff:")) {
    const ipv4 = normalized.slice("::ffff:".length);
    if (isIP(ipv4) === 4) return ipv4;
  }
  return normalized.toLowerCase();
}
