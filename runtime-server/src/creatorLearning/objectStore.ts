import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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

export interface ArtifactObjectStore {
  put(key: string, content: Buffer | string, options?: ObjectStorePutOptions): Promise<ObjectStoreObject>;
  get(key: string): Promise<Buffer>;
  list(prefix: string): Promise<string[]>;
}

/**
 * Local object-store implementation used by unit tests and explicit local
 * development. It has the same immutable-key contract as OSS but keeps the
 * network boundary out of tests.
 */
export class LocalArtifactObjectStore implements ArtifactObjectStore {
  constructor(private readonly root: string) {}

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
  get(name: string, options?: Record<string, unknown>): Promise<{ content: Buffer }>;
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
      try {
        const existing = await client.get(normalized);
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
      } catch (error) {
        if (!isNotFound(error)) throw error;
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
      if (options.immutable === false || !isAlreadyExists(error)) throw error;
      const existing = await client.get(normalized);
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
    const result = await (await this.client()).get(objectKey(this.options.prefix, key));
    if (!Buffer.isBuffer(result.content)) return Buffer.from(result.content as unknown as Uint8Array);
    return result.content;
  }

  async list(prefix: string): Promise<string[]> {
    const client = await this.client();
    const names: string[] = [];
    let marker: string | undefined;
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
    return names;
  }

  private async client(): Promise<AliOssClient> {
    this.clientPromise ??= this.createClient();
    return this.clientPromise;
  }

  private async createClient(): Promise<AliOssClient> {
    const credential = this.options.credential ?? defaultCredential();
    const initial = await credential.getCredential();
    const OSS = requireAliOss();
    return new OSS({
      bucket: this.options.bucket,
      region: this.options.region ?? "oss-cn-shanghai",
      ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}),
      ...(this.options.internal === undefined ? {} : { internal: this.options.internal }),
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

function defaultCredential(): { getCredential(): Promise<{ accessKeyId?: string; accessKeySecret?: string; securityToken?: string }> } {
  const Constructor = (CredentialPackage as unknown as { default?: new () => { getCredential(): Promise<{ accessKeyId?: string; accessKeySecret?: string; securityToken?: string }> } }).default
    ?? (CredentialPackage as unknown as new () => { getCredential(): Promise<{ accessKeyId?: string; accessKeySecret?: string; securityToken?: string }> });
  return new Constructor();
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

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && ["NoSuchKey", "NoSuchObject", "NotFound", "404"].includes(String((error as { code?: string; status?: number }).code ?? (error as { status?: number }).status)));
}

function isAlreadyExists(error: unknown): boolean {
  const value = error as { code?: string; status?: number } | undefined;
  return Boolean(value && ["PreconditionFailed", "ObjectAlreadyExists", "FileAlreadyExists", "409", "412"].includes(String(value.code ?? value.status)));
}
