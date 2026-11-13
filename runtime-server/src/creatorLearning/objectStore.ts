import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import * as CredentialPackage from "@alicloud/credentials";

export type ObjectStorePutOptions = {
  contentType?: string;
  metadata?: Record<string, string>;
  immutable?: boolean;
};

export type ObjectStoreObject = {
  key: string;
  sha256: string;
  bytes: number;
  contentType?: string;
};

/** A short-lived URL for one object: PUT it from a browser, or GET it from a sandbox. Send exactly `headers` with it. */
export type PresignedRequest = { url: string; method: "PUT" | "GET"; headers: Record<string, string>; expiresAt: string };
export type PresignOptions = { method: "PUT" | "GET"; expiresSeconds: number; contentType?: string };

export interface ArtifactObjectStore {
  put(key: string, content: Buffer | string, options?: ObjectStorePutOptions): Promise<ObjectStoreObject>;
  get(key: string): Promise<Buffer>;
  list(prefix: string): Promise<string[]>;
  /** Copies one object to a new key inside the store, without its bytes passing through the caller. An existing target is left as it is. */
  copy(from: string, to: string): Promise<void>;
  presign(key: string, options: PresignOptions): Promise<PresignedRequest>;
  /** Size and content type of an object, without reading it; undefined when there is none. */
  head(key: string): Promise<{ bytes: number; contentType?: string } | undefined>;
}

/** Where the Local store's browser uploads are received: the Registry route that calls `LocalArtifactObjectStore.receive`. */
export const LOCAL_OBJECTS_PATH = "/v1/local-objects/";

/**
 * Local object-store implementation used by unit tests and explicit local
 * development. It has the same immutable-key contract as OSS but keeps the
 * network boundary out of tests.
 */
export class LocalArtifactObjectStore implements ArtifactObjectStore {
  private readonly secret = randomBytes(32);
  private readonly types = new Map<string, string>();
  constructor(private readonly root: string) {}

  private sign(key: string, expires: number, contentType: string) {
    return createHmac("sha256", this.secret).update(`${key}\n${expires}\n${contentType}`).digest("hex");
  }

  /** Dev and tests only. Uploads are accepted by the Registry itself; a sandbox cannot reach this machine, so downloads are refused. */
  async presign(key: string, options: PresignOptions): Promise<PresignedRequest> {
    if (options.method === "GET") throw new Error("The local object store cannot serve downloads to a hosted sandbox; configure HATCH_CREATOR_OBJECT_STORE_BUCKET");
    safeKey(key);
    const expires = Date.now() + options.expiresSeconds * 1000;
    const contentType = options.contentType ?? "application/octet-stream";
    const query = new URLSearchParams({ expires: String(expires), type: contentType, sig: this.sign(key, expires, contentType) });
    return { url: `${LOCAL_OBJECTS_PATH}${key.split("/").map(encodeURIComponent).join("/")}?${query}`, method: "PUT", headers: { "Content-Type": contentType }, expiresAt: new Date(expires).toISOString() };
  }

  /** Stores the bytes of a browser upload when the signed query is valid and unexpired. */
  async receive(key: string, query: URLSearchParams, bytes: Buffer, contentType: string | undefined): Promise<void> {
    const expires = Number(query.get("expires"));
    const type = query.get("type") ?? "";
    const given = Buffer.from(query.get("sig") ?? "", "hex");
    const expected = Buffer.from(this.sign(key, expires, type), "hex");
    if (!(expires > Date.now()) || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error("The upload link is invalid or expired");
    if ((contentType ?? "").split(";")[0]!.trim() !== type) throw new Error("The upload's Content-Type does not match the link");
    await this.put(key, bytes, { contentType: type, immutable: false });
  }

  async copy(from: string, to: string): Promise<void> {
    const destination = containedPath(this.root, to);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(containedPath(this.root, from), destination, fsConstants.COPYFILE_EXCL).catch((error: unknown) => { if (!isFileAlreadyExists(error)) throw error; });
    const type = this.types.get(from);
    if (type) this.types.set(to, type);
  }

  async head(key: string) {
    const bytes = await stat(containedPath(this.root, key)).then(info => info.size, (error: unknown) => { if (isMissing(error)) return undefined; throw error; });
    return bytes === undefined ? undefined : { bytes, ...(this.types.has(key) ? { contentType: this.types.get(key) } : {}) };
  }

  async put(key: string, content: Buffer | string, options: ObjectStorePutOptions = {}): Promise<ObjectStoreObject> {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const destination = containedPath(this.root, key);
    await mkdir(path.dirname(destination), { recursive: true });
    if (options.immutable === false) {
      await writeFile(destination, bytes);
    } else {
      await writeFile(destination, bytes, { flag: "wx" }).catch(async (error: unknown) => {
        if (!isFileAlreadyExists(error)) throw error;
        const existing = await readFile(destination);
        if (!existing.equals(bytes)) throw new Error(`Immutable object key already contains different bytes: ${key}`);
      });
    }
    if (options.contentType) this.types.set(key, options.contentType);
    return {
      key,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      ...(options.contentType ? { contentType: options.contentType } : {})
    };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(containedPath(this.root, key));
  }

  async list(prefix: string): Promise<string[]> {
    const base = containedPath(this.root, prefix || ".");
    const root = await stat(base).then(() => base).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (!root) return [];
    return walk(this.root, root);
  }
}

type AliOssClient = {
  put(name: string, content: Buffer, options?: Record<string, unknown>): Promise<unknown>;
  generateObjectUrl(name: string): string;
  get(name: string, options?: Record<string, unknown>): Promise<{ content: Buffer }>;
  delete(name: string): Promise<unknown>;
  copy(name: string, source: string, options?: Record<string, unknown>): Promise<unknown>;
  head(name: string): Promise<{ res?: { headers?: Record<string, unknown> } }>;
  signatureUrl(name: string, options: Record<string, unknown>): string;
  putACL(name: string, acl: "private" | "public-read" | "public-read-write"): Promise<{ res?: { status?: number } }>;
  processObjectSave(source: string, target: string, process: string): Promise<{
    res?: { status?: number; headers?: Record<string, unknown> };
  }>;
  list(query?: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ objects?: Array<{ name?: string }>; isTruncated?: boolean; nextMarker?: string | null }>;
};

type AliOssConstructor = new (options: Record<string, unknown>) => AliOssClient;

/**
 * Real production Object Store adapter. Credentials are resolved through the
 * Alibaba default chain, which uses HatchRuntimeRole on ECS; no long-lived
 * AccessKey is stored in Hatch configuration.
 */
export class AliyunArtifactObjectStore implements ArtifactObjectStore {
  private clientPromise?: Promise<AliOssClient>;
  private publicUrlClientPromise?: Promise<AliOssClient>;
  private credentialProvider?: { getCredential(): Promise<{ accessKeyId?: string; accessKeySecret?: string; securityToken?: string }> };

  constructor(
    private readonly options: {
      bucket: string;
      region?: string;
      endpoint?: string;
      internal?: boolean;
      prefix?: string;
      credential?: { getCredential(): Promise<{ accessKeyId?: string; accessKeySecret?: string; securityToken?: string }> };
    }
  ) {}

  async put(key: string, content: Buffer | string, options: ObjectStorePutOptions = {}): Promise<ObjectStoreObject> {
    const normalized = objectKey(this.options.prefix, key);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const client = await this.client();
    if (options.immutable !== false) {
      let existing: { content: Buffer } | undefined;
      try {
        existing = await client.get(normalized);
      } catch (error) {
        if (!isObjectStoreNotFound(error)) throw this.withContext("GET", error);
      }
      if (existing) {
        const existingBytes = Buffer.isBuffer(existing.content)
          ? existing.content
          : Buffer.from(existing.content as unknown as Uint8Array);
        if (!existingBytes.equals(bytes)) throw new Error(`Immutable object key already contains different bytes: ${key}`);
        return {
          key,
          sha256: sha256(bytes),
          bytes: bytes.byteLength,
          ...(options.contentType ? { contentType: options.contentType } : {})
        };
      }
    }
    try {
      await client.put(normalized, bytes, {
        ...(options.contentType ? { mime: options.contentType } : {}),
        ...(options.metadata ? { meta: options.metadata } : {}),
        // OSS honours this header atomically. The GET above is only the fast
        // idempotent path; this prevents two workers from replacing an
        // immutable key between GET and PUT.
        ...(options.immutable !== false ? { headers: { "x-oss-forbid-overwrite": "true" } } : {})
      });
    } catch (error) {
      if (options.immutable === false || !isAlreadyExists(error)) throw this.withContext("PUT", error);
      let existing: { content: Buffer };
      try {
        existing = await client.get(normalized);
      } catch (getError) {
        throw this.withContext("GET", getError);
      }
      const existingBytes = Buffer.isBuffer(existing.content)
        ? existing.content
        : Buffer.from(existing.content as unknown as Uint8Array);
      if (!existingBytes.equals(bytes)) throw new Error(`Immutable object key already contains different bytes: ${key}`);
    }
    return {
      key,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      ...(options.contentType ? { contentType: options.contentType } : {})
    };
  }

  async get(key: string): Promise<Buffer> {
    try {
      const result = await (await this.client()).get(objectKey(this.options.prefix, key));
      if (!Buffer.isBuffer(result.content)) return Buffer.from(result.content as unknown as Uint8Array);
      return result.content;
    } catch (error) {
      throw this.withContext("GET", error);
    }
  }

  async processImageSave(source: string, target: string, process: string): Promise<void> {
    try {
      const result = await (await this.client()).processObjectSave(
        objectKey(this.options.prefix, source),
        objectKey(this.options.prefix, target),
        process
      );
      if (result.res?.status !== 200) {
        throw Object.assign(new Error(`OSS image processing returned status ${result.res?.status ?? "unknown"}`), {
          code: responseHeader(result.res?.headers, "x-oss-ec-code")
            ?? responseHeader(result.res?.headers, "x-oss-ec"),
          requestId: responseHeader(result.res?.headers, "x-oss-request-id"),
          hostId: responseHeader(result.res?.headers, "x-oss-ec-host-id")
        });
      }
    } catch (error) {
      throw this.withContext("IMAGE PROCESS", error);
    }
  }

  async makePublicRead(key: string): Promise<void> {
    try {
      const result = await (await this.client()).putACL(objectKey(this.options.prefix, key), "public-read");
      if (result.res?.status !== 200) throw new Error(`OSS object ACL update returned status ${result.res?.status ?? "unknown"}`);
    } catch (error) {
      throw this.withContext("SET PUBLIC READ", error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await (await this.client()).delete(objectKey(this.options.prefix, key));
    } catch (error) {
      throw this.withContext("DELETE", error);
    }
  }

  async list(prefix: string): Promise<string[]> {
    const client = await this.client();
    const names: string[] = [];
    let marker: string | undefined;
    try {
      do {
        const result = await client.list({
          prefix: objectKey(this.options.prefix, prefix),
          ...(marker ? { marker } : {}),
          "max-keys": 1000
        });
        for (const item of result.objects ?? []) {
          if (typeof item.name !== "string") continue;
          names.push(stripPrefix(this.options.prefix, item.name));
        }
        marker = result.isTruncated ? (result.nextMarker ?? undefined) : undefined;
      } while (marker);
    } catch (error) {
      throw this.withContext("LIST", error);
    }
    return names;
  }

  /** Signed with the public endpoint, since the browser and the sandbox are outside the VPC. A fresh client each time takes the current STS credential. */
  async presign(key: string, options: PresignOptions): Promise<PresignedRequest> {
    const client = await this.createClient(true);
    const contentType = options.contentType ?? "application/octet-stream";
    const url = client.signatureUrl(objectKey(this.options.prefix, key), {
      method: options.method, expires: options.expiresSeconds, ...(options.method === "PUT" ? { "Content-Type": contentType } : {})
    });
    return { url, method: options.method, headers: options.method === "PUT" ? { "Content-Type": contentType } : {}, expiresAt: new Date(Date.now() + options.expiresSeconds * 1000).toISOString() };
  }

  /** Server-side CopyObject: the bytes never leave OSS. The immutable-key header makes a repeat a no-op. */
  async copy(from: string, to: string): Promise<void> {
    try {
      await (await this.client()).copy(objectKey(this.options.prefix, to), objectKey(this.options.prefix, from), { headers: { "x-oss-forbid-overwrite": "true" } });
    } catch (error) {
      if (!isAlreadyExists(error)) throw this.withContext("COPY", error);
    }
  }

  async head(key: string) {
    try {
      const headers = (await (await this.client()).head(objectKey(this.options.prefix, key))).res?.headers ?? {};
      return { bytes: Number(headers["content-length"]), ...(typeof headers["content-type"] === "string" ? { contentType: headers["content-type"] } : {}) };
    } catch (error) {
      if (isObjectStoreNotFound(error)) return undefined;
      throw this.withContext("HEAD", error);
    }
  }

  async generatePublicObjectUrl(key: string): Promise<string> {
    this.publicUrlClientPromise ??= this.createClient(true);
    return (await this.publicUrlClientPromise).generateObjectUrl(objectKey(this.options.prefix, key));
  }

  private withContext(operation: string, error: unknown): Error {
    const source = error instanceof Error ? error : new Error(String(error));
    const value = error && typeof error === "object" ? error as {
      code?: string;
      status?: number;
      requestId?: string;
      hostId?: string;
    } : {};
    const details = [
      value.code ? `code=${value.code}` : "",
      value.status === undefined ? "" : `status=${value.status}`,
      value.requestId ? `requestId=${value.requestId}` : "",
      value.hostId ? `hostId=${value.hostId}` : ""
    ].filter(Boolean).join(", ");
    source.message = `OSS ${operation} failed (${this.targetDescription()}): ${source.message}${details ? ` [${details}]` : ""}`;
    return source;
  }

  private targetDescription(): string {
    let endpoint = this.options.endpoint;
    if (!endpoint) {
      const region = this.options.region ?? "oss-cn-shanghai";
      endpoint = `${region}${this.options.internal ? "-internal" : ""}.aliyuncs.com`;
    }
    try {
      return `${this.options.bucket}@${new URL(endpoint).host}`;
    } catch {
      return `${this.options.bucket}@${endpoint.replace(/^https?:\/\//, "").split("/")[0]}`;
    }
  }

  private async client(): Promise<AliOssClient> {
    this.clientPromise ??= this.createClient();
    return this.clientPromise;
  }

  private async createClient(publicEndpoint = false): Promise<AliOssClient> {
    const credential = this.credentialProvider ??= this.options.credential ?? defaultCredential();
    const initial = await credential.getCredential();
    const OSS = requireAliOss();
    return new OSS({
      bucket: this.options.bucket,
      region: this.options.region ?? "oss-cn-shanghai",
      ...(!publicEndpoint && this.options.endpoint ? { endpoint: this.options.endpoint } : {}),
      ...(publicEndpoint ? { internal: false } : this.options.internal === undefined ? {} : { internal: this.options.internal }),
      // HTTPS for every request and every generated URL: Desktop's WebView
      // refuses plaintext images, and public avatar URLs are stored as-is.
      secure: true,
      accessKeyId: requireCredential(initial.accessKeyId, "accessKeyId"),
      accessKeySecret: requireCredential(initial.accessKeySecret, "accessKeySecret"),
      ...(initial.securityToken ? { stsToken: initial.securityToken } : {}),
      refreshSTSToken: async () => {
        const next = await credential.getCredential();
        return {
          accessKeyId: requireCredential(next.accessKeyId, "accessKeyId"),
          accessKeySecret: requireCredential(next.accessKeySecret, "accessKeySecret"),
          stsToken: requireCredential(next.securityToken, "securityToken")
        };
      }
    }) as AliOssClient;
  }
}

export function objectStoreFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  localRoot?: string
): ArtifactObjectStore | undefined {
  const bucket = environment.HATCH_CREATOR_OBJECT_STORE_BUCKET?.trim();
  if (bucket) {
    return new AliyunArtifactObjectStore({
      bucket,
      region: environment.HATCH_CREATOR_OBJECT_STORE_REGION?.trim() || "oss-cn-shanghai",
      ...(environment.HATCH_CREATOR_OBJECT_STORE_ENDPOINT?.trim()
        ? { endpoint: environment.HATCH_CREATOR_OBJECT_STORE_ENDPOINT.trim() }
        : {}),
      ...(environment.HATCH_CREATOR_OBJECT_STORE_INTERNAL === undefined
        ? { internal: true }
        : { internal: environment.HATCH_CREATOR_OBJECT_STORE_INTERNAL.trim().toLowerCase() === "true" }),
      prefix: environment.HATCH_CREATOR_OBJECT_STORE_PREFIX?.trim() || "hatch"
    });
  }
  if (environment.NODE_ENV === "production") {
    throw new Error("HATCH_CREATOR_OBJECT_STORE_BUCKET is required in production");
  }
  return localRoot ? new LocalArtifactObjectStore(localRoot) : undefined;
}

export function defaultCredential(): { getCredential(): Promise<{ accessKeyId?: string; accessKeySecret?: string; securityToken?: string }> } {
  // `@alicloud/credentials` is CommonJS. TypeScript's native ESM transform
  // exposes its CommonJS namespace as `default.default`, while a CJS
  // `require()` exposes the constructor as `default`. Resolve both shapes so
  // production does not fail only when the first OSS-backed request arrives.
  type CredentialConstructor = new () => { getCredential(): Promise<{ accessKeyId?: string; accessKeySecret?: string; securityToken?: string }> };
  const namespace = CredentialPackage as unknown as { default?: unknown };
  const nested = namespace.default as { default?: unknown } | undefined;
  const candidate = typeof namespace.default === "function"
    ? namespace.default
    : nested && typeof nested.default === "function"
      ? nested.default
      : undefined;
  if (typeof candidate !== "function") throw new Error("Alibaba credentials package did not expose a default provider constructor");
  return new (candidate as CredentialConstructor)();
}

function requireAliOss(): AliOssConstructor {
  const require = createRequire(import.meta.url);
  return require("ali-oss") as AliOssConstructor;
}

function objectKey(prefix: string | undefined, key: string): string {
  const normalized = safeKey(key);
  return prefix ? `${safeKey(prefix)}/${normalized}` : normalized;
}

function stripPrefix(prefix: string | undefined, key: string): string {
  const normalized = prefix ? `${safeKey(prefix)}/` : "";
  return normalized && key.startsWith(normalized) ? key.slice(normalized.length) : key;
}

function safeKey(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Object key must be a safe relative path: ${value}`);
  }
  return normalized;
}

function containedPath(root: string, key: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, safeKey(key));
  if (!resolved.startsWith(`${base}${path.sep}`)) throw new Error(`Object key escapes local store: ${key}`);
  return resolved;
}

async function walk(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const rows: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...await walk(root, absolute));
    else if (entry.isFile()) rows.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
  }
  return rows;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function responseHeader(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = headers?.[name];
  return typeof value === "string" ? value : undefined;
}

function requireCredential(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Alibaba credential ${label} is unavailable`);
  return value;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ENOENT");
}

function isFileAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "EEXIST");
}

export function isObjectStoreNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && ["ENOENT", "NoSuchKey", "NoSuchObject", "NotFound", "404"].includes(String((error as { code?: string; status?: number }).code ?? (error as { status?: number }).status)));
}

function isAlreadyExists(error: unknown): boolean {
  const value = error as { code?: string; status?: number } | undefined;
  return Boolean(value && ["PreconditionFailed", "ObjectAlreadyExists", "FileAlreadyExists", "409", "412"].includes(String(value.code ?? value.status)));
}
