import { MAX_BYTES } from "../assets/pipeline.js";
import { sniff } from "../assets/sniff.js";
import type { AccountFile, AccountFiles } from "./accountFiles.js";
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
  constructor(private readonly files: AccountFiles | undefined) {}

  private store(): AccountFiles {
    if (!this.files) throw new ApiError(501, "server_error", "files_unavailable", "This Runtime cannot store files.");
    return this.files;
  }

  /** `file` and `purpose` from the multipart form the official SDKs send. */
  async create(caller: ApiCaller, form: FormData) {
    const file = form.get("file");
    if (!(file instanceof File)) throw invalidRequest("invalid_request", "A multipart `file` part is required.", "file");
    const content = Buffer.from(await file.arrayBuffer());
    if (!content.length) throw invalidRequest("invalid_request", "The file is empty.", "file");
    const filename = file.name || "file";
    const kind = sniff(content, filename).kind;
    if (content.length > MAX_BYTES[kind]) throw new ApiError(413, "invalid_request_error", "file_too_large", `That file is too large (${kind} limit ${MAX_BYTES[kind]} bytes).`, "file");
    const purpose = form.get("purpose");
    return fileObject(await this.store().put(caller.accountId, { filename, purpose: typeof purpose === "string" && purpose ? purpose : "user_data", content }));
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
