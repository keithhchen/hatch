import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import type { ChatAssets } from "../chat/assets.js";
import type { ConversationRecord } from "../conversationRepository.js";
import { MAX_BYTES } from "../assets/pipeline.js";
import type { ContentPart } from "../surfaces/contract.js";
import { ApiError, invalidRequest } from "./errors.js";
import type { FilesApi } from "./files.js";
import type { AttachmentSource, InputPart } from "./request.js";

/** How an https URL becomes bytes. The production one refuses anything that is not the public internet. */
export interface UrlFetcher {
  fetch(url: string, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Buffer; contentType?: string }>;
}

const NON_PUBLIC = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) NON_PUBLIC.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b::", 96]] as const) NON_PUBLIC.addSubnet(network, prefix, "ipv6");

/** Whether an address belongs to the public internet: loopback, private, link-local, reserved and multicast ranges do not. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  const mapped = family === 6 ? address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1] : undefined;
  if (mapped) return isPublicAddress(mapped);
  return !NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

const FETCH_TIMEOUT_MS = 10_000;

/** https only, no redirects, a 10 s timeout, a byte cap, and every address the name resolves to must be public (connected to as resolved, so a rebinding name cannot swap it). */
export class PublicHttpsFetcher implements UrlFetcher {
  fetch(url: string, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Buffer; contentType?: string }> {
    return new Promise((resolve, reject) => {
      const lookup: net.LookupFunction = (hostname, options, callback) => {
        dns.lookup(hostname, { all: true }, (error, addresses) => {
          if (error) return callback(error, "", 4);
          if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
            return callback(new Error("The URL does not resolve to a public address."), "", 4);
          }
          if ((options as { all?: boolean }).all) return (callback as unknown as (error: null, all: dns.LookupAddress[]) => void)(null, addresses);
          return callback(null, addresses[0]!.address, addresses[0]!.family);
        });
      };
      let target: URL;
      try { target = new URL(url); } catch { return reject(invalidRequest("invalid_request", "The attachment URL is not valid.")); }
      if (target.protocol !== "https:") return reject(invalidRequest("invalid_request", "Attachment URLs must be https."));
      const request = https.get(target, { lookup, timeout: FETCH_TIMEOUT_MS, ...(signal ? { signal } : {}) }, (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          return reject(invalidRequest("invalid_request", `The attachment URL answered ${status}${status >= 300 && status < 400 ? " (redirects are not followed)" : ""}.`));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) { response.destroy(); return reject(new ApiError(413, "invalid_request_error", "file_too_large", "The attachment is too large.")); }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ bytes: Buffer.concat(chunks), ...(response.headers["content-type"] ? { contentType: String(response.headers["content-type"]).split(";")[0]!.trim() } : {}) }));
        response.on("error", () => reject(invalidRequest("invalid_request", "The attachment could not be fetched.")));
      });
      request.on("timeout", () => request.destroy(new Error("timeout")));
      request.on("error", (error) => reject(error instanceof ApiError ? error : invalidRequest("invalid_request", `The attachment URL could not be fetched: ${error.message}`)));
    });
  }
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic",
  "application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "application/json": "json"
};

/** A file name the pipeline can sniff by: the caller's, else the URL's last segment, else one made from the media type. */
function nameOf(part: Extract<InputPart, { type: "image" | "file" }>, mediaType: string | undefined, index: number): string {
  if (part.type === "file" && part.filename) return part.filename;
  if (part.source.kind === "url") {
    const last = decodeURIComponent(new URL(part.source.url).pathname.split("/").pop() ?? "");
    if (/\.[A-Za-z0-9]{1,8}$/.test(last)) return last;
  }
  const extension = EXTENSIONS[(mediaType ?? "").toLowerCase()];
  return `${part.type === "image" ? "image" : "file"}-${index + 1}${extension ? `.${extension}` : ""}`;
}

/**
 * Attachments of a request (data URLs, https URLs, Files API files) put through the same door as every client's upload:
 * a ready asset of the conversation, referenced by the message.
 */
export class InlineAttachments {
  constructor(private readonly deps: { assets: ChatAssets | undefined; urls: UrlFetcher; files: FilesApi }) {}

  async contentParts(parts: readonly InputPart[], conversation: ConversationRecord, signal?: AbortSignal): Promise<ContentPart[]> {
    const out: ContentPart[] = [];
    for (const [index, part] of parts.entries()) {
      if (part.type === "text") { out.push({ type: "text", text: part.text }); continue; }
      const assets = this.deps.assets;
      if (!assets) throw new ApiError(501, "server_error", "attachments_unavailable", "This Runtime cannot take attachments.");
      const { bytes, mediaType, filename } = await this.read(part.source, conversation.ownerAccountId, signal);
      if (!bytes.length) throw invalidRequest("invalid_request", "An attachment is empty.");
      const uploaded = await assets.upload(conversation, { name: filename ?? nameOf(part, mediaType, index), bytes });
      if (part.type === "image" && uploaded.kind !== "image") throw new ApiError(415, "invalid_request_error", "unsupported_file_type", "input_image must be an image.");
      out.push({ type: uploaded.kind, assetId: uploaded.asset_id });
    }
    return out;
  }

  /** A Files API file is read as its account's, the conversation's owner: another account's id is not found. */
  private async read(source: AttachmentSource, accountId: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mediaType?: string; filename?: string }> {
    if (source.kind === "file") return this.deps.files.read(accountId, source.id);
    if (source.kind === "data") return { bytes: Buffer.from(source.base64, "base64"), mediaType: source.mediaType };
    const fetched = await this.deps.urls.fetch(source.url, Math.max(...Object.values(MAX_BYTES)), signal);
    return { bytes: fetched.bytes, ...(fetched.contentType ? { mediaType: fetched.contentType } : {}) };
  }
}
