import { randomUUID } from "node:crypto";
import type { Account, AccountStoreTs } from "./registryAuth.js";
import { runtimeObjectStoreFromEnvironment } from "./assetStore.js";
import type { AliyunArtifactObjectStore } from "./creatorLearning/objectStore.js";

export const MAX_ACCOUNT_AVATAR_BYTES = 5 * 1024 * 1024;
const AVATAR_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AVATAR_OBJECT_PREFIX = "account-avatars";

export interface AccountAvatarFileStore {
  publish(accountId: string, image: Buffer, mediaType: string): Promise<string>;
  remove(publicUrl: string): Promise<void>;
}

export class AccountAvatarApplicationService {
  constructor(
    private readonly accounts: Pick<AccountStoreTs, "getById" | "setAvatarUrl">,
    private readonly files: AccountAvatarFileStore
  ) {}

  async replace(accountId: string, image: Buffer, mediaType: string): Promise<Account> {
    validateAvatarImage(image, mediaType);
    const current = await this.requireAccount(accountId);
    const avatarUrl = await this.files.publish(accountId, image, mediaType);
    let saved = false;
    try {
      const account = await this.accounts.setAvatarUrl(accountId, avatarUrl);
      saved = true;
      if (current.avatar_url) await this.files.remove(current.avatar_url);
      return account;
    } finally {
      if (!saved) await this.files.remove(avatarUrl);
    }
  }

  async remove(accountId: string): Promise<Account> {
    const current = await this.requireAccount(accountId);
    const account = await this.accounts.setAvatarUrl(accountId, null);
    if (current.avatar_url) await this.files.remove(current.avatar_url);
    return account;
  }

  private async requireAccount(accountId: string): Promise<Account> {
    const account = await this.accounts.getById(accountId);
    if (!account) throw new Error("account_not_found");
    return account;
  }
}

export class AliyunAccountAvatarFileStore implements AccountAvatarFileStore {
  constructor(
    private readonly objectStore: AliyunArtifactObjectStore,
    private readonly publicBaseUrl: URL
  ) {}

  async publish(accountId: string, image: Buffer, mediaType: string): Promise<string> {
    const revision = randomUUID();
    const base = `${AVATAR_OBJECT_PREFIX}/${accountId}/${revision}`;
    const sourceKey = `${base}/source`;
    const targetKey = `${base}/avatar.webp`;
    await this.objectStore.put(sourceKey, image, { contentType: mediaType });
    try {
      await this.objectStore.processImageSave(
        sourceKey,
        targetKey,
        "image/resize,m_fill,w_512,h_512/format,webp"
      );
      await this.objectStore.makePublicRead(targetKey);
    } finally {
      await this.objectStore.delete(sourceKey);
    }
    return new URL(`${targetKey}`, ensureTrailingSlash(this.publicBaseUrl)).toString();
  }

  async remove(publicUrl: string): Promise<void> {
    const url = new URL(publicUrl);
    if (url.origin !== this.publicBaseUrl.origin) throw new Error("avatar_url_origin_invalid");
    const basePath = ensureTrailingSlash(this.publicBaseUrl).pathname;
    if (!url.pathname.startsWith(basePath)) throw new Error("avatar_url_path_invalid");
    const objectKey = decodeURIComponent(url.pathname.slice(basePath.length));
    if (!objectKey.startsWith(`${AVATAR_OBJECT_PREFIX}/`) || objectKey.split("/").some(part => part === ".." || part === "")) {
      throw new Error("avatar_url_path_invalid");
    }
    await this.objectStore.delete(objectKey);
  }
}

export function accountAvatarApplicationServiceFromEnvironment(
  accounts: Pick<AccountStoreTs, "getById" | "setAvatarUrl">,
  environment: NodeJS.ProcessEnv = process.env
): AccountAvatarApplicationService | undefined {
  const objectStore = runtimeObjectStoreFromEnvironment(environment);
  if (!objectStore) {
    if (environment.NODE_ENV === "production") throw new Error("OSS storage is required for account avatars in production");
    return undefined;
  }
  const publicBase = environment.HATCH_ACCOUNT_AVATAR_PUBLIC_BASE_URL?.trim();
  if (!publicBase) throw new Error("HATCH_ACCOUNT_AVATAR_PUBLIC_BASE_URL is required when account avatar storage is enabled");
  const publicBaseUrl = new URL(ensureTrailingSlash(new URL(publicBase)));
  if (publicBaseUrl.protocol !== "https:") throw new Error("HATCH_ACCOUNT_AVATAR_PUBLIC_BASE_URL must use HTTPS");
  return new AccountAvatarApplicationService(accounts, new AliyunAccountAvatarFileStore(objectStore, publicBaseUrl));
}

function validateAvatarImage(image: Buffer, mediaType: string): void {
  if (!AVATAR_MEDIA_TYPES.has(mediaType)) throw new Error("avatar_media_type_invalid");
  if (image.byteLength === 0 || image.byteLength > MAX_ACCOUNT_AVATAR_BYTES) throw new Error("avatar_size_invalid");
}

function ensureTrailingSlash(url: URL): URL {
  const normalized = new URL(url);
  if (!normalized.pathname.endsWith("/")) normalized.pathname += "/";
  return normalized;
}
