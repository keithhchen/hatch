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
  constructor(private readonly objectStore: AliyunArtifactObjectStore) {}

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
    return this.objectStore.generatePublicObjectUrl(targetKey);
  }

  async remove(publicUrl: string): Promise<void> {
    const objectKey = await this.objectKeyFromPublicUrl(publicUrl);
    await this.objectStore.delete(objectKey);
  }

  private async objectKeyFromPublicUrl(publicUrl: string): Promise<string> {
    const probeKey = `${AVATAR_OBJECT_PREFIX}/__url_probe__`;
    const probeUrl = new URL(await this.objectStore.generatePublicObjectUrl(probeKey));
    const url = new URL(publicUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.origin !== probeUrl.origin) {
      throw new Error("avatar_url_origin_invalid");
    }
    if (!probeUrl.pathname.endsWith(probeKey)) throw new Error("avatar_public_url_invalid");
    const publicPathPrefix = probeUrl.pathname.slice(0, -probeKey.length);
    if (!url.pathname.startsWith(publicPathPrefix)) throw new Error("avatar_url_path_invalid");
    const objectKey = decodeURIComponent(url.pathname.slice(publicPathPrefix.length));
    if (!objectKey.startsWith(`${AVATAR_OBJECT_PREFIX}/`) || objectKey.split("/").some(part => part === ".." || part === "." || part === "")) {
      throw new Error("avatar_url_path_invalid");
    }
    return objectKey;
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
  return new AccountAvatarApplicationService(accounts, new AliyunAccountAvatarFileStore(objectStore));
}

function validateAvatarImage(image: Buffer, mediaType: string): void {
  if (!AVATAR_MEDIA_TYPES.has(mediaType)) throw new Error("avatar_media_type_invalid");
  if (image.byteLength === 0 || image.byteLength > MAX_ACCOUNT_AVATAR_BYTES) throw new Error("avatar_size_invalid");
}
