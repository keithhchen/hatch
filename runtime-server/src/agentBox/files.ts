import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import path from "node:path";
import { Asset, scopeKey, type AssetBlobs, type AssetRepository, type AssetScope } from "../assets/domain.js";

export type BuyerScope = Extract<AssetScope, { kind: "buyer" }>;

/** A file kept for a buyer of a Product: what a tool hands back and what other tools take, by id. */
export type SavedFile = { id: string; name: string; mime: string; bytes: number; url: string };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".json": "application/json", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml"
};
export const mimeOf = (name: string): string => MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";

/** Where a file's bytes are, under its scope: the same layout uploaded attachments use. */
export const originalKey = (scope: AssetScope, sha256: string): string => `${scopeKey(scope)}/${sha256}/original`;

/** A file's download link is signed for that file id and never expires: a buyer may forward it. */
export class FileLinks {
  private readonly key: Buffer;
  constructor(secret: string, private readonly origin: string) {
    if (!secret.trim()) throw new Error("File links need a signing secret");
    this.key = createHmac("sha256", secret).update("hatch-file-link-v1").digest();
  }
  token(fileId: string): string { return createHmac("sha256", this.key).update(fileId).digest("base64url"); }
  verify(fileId: string, token: string | null): boolean {
    if (!token) return false;
    const expected = Buffer.from(this.token(fileId)), supplied = Buffer.from(token);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }
  url(fileId: string): string { return `${this.origin}/file/${fileId}?t=${this.token(fileId)}`; }
}

/**
 * The buyer's files: content in object storage, a record in the asset table. One record per content in a scope, so saving the
 * same bytes again gives the same id; a crash between the two writes leaves a `processing` record that the next save finishes.
 */
export class BuyerFiles {
  constructor(private readonly repository: AssetRepository, private readonly blobs: AssetBlobs, private readonly links: FileLinks) {}

  private view = (asset: Asset): SavedFile => ({ id: asset.id, name: asset.record.name, mime: asset.record.mime, bytes: asset.record.bytes, url: this.links.url(asset.id) });

  async save(scope: BuyerScope, name: string, bytes: Buffer): Promise<SavedFile> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const mime = mimeOf(name);
    const { asset } = await this.repository.insertIfAbsent(Asset.received({ scope, sha256, kind: mime.startsWith("image/") ? "image" : "file", mime, name, bytes: bytes.length }));
    if (asset.state === "ready") return this.view(asset);
    await this.blobs.put(originalKey(scope, sha256), bytes, { contentType: mime });
    const ready = await this.repository.transition("processing", asset.ready([]));
    return this.view(ready ?? (await this.repository.get(scope, asset.id))!);
  }

  /** The file with this id in this scope, or undefined: another buyer's id is not found, not refused. */
  async find(scope: BuyerScope, id: string): Promise<SavedFile | undefined> {
    const asset = await this.repository.get(scope, id);
    return asset?.state === "ready" ? this.view(asset) : undefined;
  }

  async content(scope: BuyerScope, id: string): Promise<Buffer | undefined> {
    const asset = await this.repository.get(scope, id);
    return asset?.state === "ready" ? this.blobs.get(originalKey(scope, asset.record.sha256)) : undefined;
  }

  /** A saved file for a valid link: its scope comes from its own record. Undefined for anything else, so a wrong link and a missing file look the same. */
  async download(id: string, token: string | null): Promise<{ name: string; mime: string; bytes: Buffer } | undefined> {
    if (!this.links.verify(id, token)) return undefined;
    const asset = await this.repository.byId(id);
    const scope = asset?.record.scope;
    if (!asset || scope?.kind !== "buyer") return undefined;
    const bytes = await this.content(scope, id);
    return bytes && { name: asset.record.name, mime: asset.record.mime, bytes };
  }
}

const ROUTE = /^\/file\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** GET /file/<id>?t=<signature>: the file as a download, never rendered on our origin. Returns false for a path that is not a file link. */
export async function handleFileRoute(request: http.IncomingMessage, response: http.ServerResponse, url: URL, files: BuyerFiles | undefined): Promise<boolean> {
  const match = ROUTE.exec(url.pathname);
  if (!match) return false;
  const file = request.method === "GET" && files ? await files.download(match[1]!, url.searchParams.get("t")) : undefined;
  const headers = { "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
  if (!file) {
    response.writeHead(files ? 404 : 503, { ...headers, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invalid link</title></head><body style="font:16px/1.75 system-ui,sans-serif;margin:0;padding:48px 24px;text-align:center">链接无效 · Invalid link</body></html>');
    return true;
  }
  const ascii = file.name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  response.writeHead(200, {
    ...headers,
    "content-type": file.mime,
    "content-length": file.bytes.length,
    "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    "cache-control": "private, max-age=3600",
  });
  response.end(file.bytes);
  return true;
}
