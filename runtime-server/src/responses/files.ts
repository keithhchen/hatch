import { refusal } from "../chat/assets.js";
import type { ChatAssets } from "../chat/assets.js";
import { StorageQuotaExceeded, type AccountFile, type AccountFiles } from "./accountFiles.js";
import type { ApiCaller } from "./auth.js";
import { ApiError, invalidRequest, notFound } from "./errors.js";

/** The OpenAI File object. `purpose` is stored as sent and otherwise ignored. */
const fileObject = (file: AccountFile) => ({
  id: file.id, object: "file" as const, bytes: file.bytes, created_at: Math.floor(file.createdAt.getTime() / 1000),
  filename: file.filename, purpose: file.purpose, status: "processed" as const
});

export const fileNotFound = (id: string): ApiError => notFound("file_not_found", `No file with id '${id}' was found.`);

/**
 * The Files API subset: an account's files, private to it. A file joins a conversation only when an input item names it
 * (see InlineAttachments), through the same asset path as an inline attachment.
 */
export class FilesApi {
  /** `assets` decides which types and sizes are accepted: the same detection the conversation upload uses. */
  constructor(private readonly files: AccountFiles | undefined, private readonly assets: ChatAssets | undefined) {}

  private store(): AccountFiles {
    if (!this.files || !this.assets) throw new ApiError(501, "server_error", "files_unavailable", "This Runtime cannot store files.");
    return this.files;
  }

  /** `file` and `purpose` from the multipart form the official SDKs send. */
  async create(caller: ApiCaller, form: FormData) {
    const file = form.get("file");
    if (!(file instanceof File)) throw invalidRequest("invalid_request", "A multipart `file` part is required.", "file");
    const content = Buffer.from(await file.arrayBuffer());
    if (!content.length) throw invalidRequest("invalid_request", "The file is empty.", "file");
    const filename = file.name || "file";
    const store = this.store();
    try { this.assets!.detect(filename, content); } catch (error) { throw refusal(error); }
    const purpose = form.get("purpose");
    try {
      return fileObject(await store.put(caller.accountId, { filename, purpose: typeof purpose === "string" && purpose ? purpose : "user_data", content }));
    } catch (error) {
      if (!(error instanceof StorageQuotaExceeded)) throw error;
      const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
      throw invalidRequest("storage_quota_exceeded", `File storage is ${mb(error.used)} of ${mb(error.quota)} used and this file does not fit. Delete files to free space.`);
    }
  }

  async list(caller: ApiCaller, query: URLSearchParams) {
    const all = (await this.store().list(caller.accountId)).filter((file) => !query.get("purpose") || file.purpose === query.get("purpose"));
    if (query.get("order") === "asc") all.reverse();
    const limit = Number(query.get("limit") ?? 10_000);
    const data = all.slice(0, Number.isInteger(limit) && limit > 0 ? limit : 10_000).map(fileObject);
    return { object: "list" as const, data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: data.length < all.length };
  }

  async get(caller: ApiCaller, id: string) {
    const file = await this.store().get(caller.accountId, id);
    if (!file) throw fileNotFound(id);
    return fileObject(file);
  }

  async content(caller: ApiCaller, id: string): Promise<Buffer> {
    return (await this.read(caller.accountId, id)).bytes;
  }

  async delete(caller: ApiCaller, id: string) {
    if (!await this.store().delete(caller.accountId, id)) throw fileNotFound(id);
    return { id, object: "file" as const, deleted: true };
  }

  /** The bytes and name of a file, for download and for an input item. The account is the caller, or the conversation's owner. */
  async read(accountId: string, id: string): Promise<{ bytes: Buffer; filename: string }> {
    const file = await this.store().get(accountId, id);
    const bytes = file && await this.store().content(accountId, id);
    if (!file || !bytes) throw fileNotFound(id);
    return { bytes, filename: file.filename };
  }
}
