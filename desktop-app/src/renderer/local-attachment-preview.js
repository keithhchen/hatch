// Ephemeral LRU previews; committed references remain the durable authority.
const readers = new WeakMap();
export function readLocalAttachmentImage(invoke, reference) {
  let reader = readers.get(invoke);
  if (!reader) { reader = createLocalAttachmentImageReader(invoke); readers.set(invoke, reader); }
  return reader(reference);
}

export function createLocalAttachmentImageReader(invoke, { maxBytes = 32 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid preview cache budget");
  const pending = new Map();
  const completed = new Map();
  let retainedBytes = 0;
  return function read(reference) {
  const key = JSON.stringify([reference.hostId, reference.attachmentId, reference.localPath, reference.sha256]);
  if (completed.has(key)) {
    const hit = completed.get(key);
    completed.delete(key);
    completed.set(key, hit);
    return Promise.resolve(hit.url);
  }
  if (pending.has(key)) return pending.get(key);
  const request = Promise.resolve().then(async () => {
    // An ID lookup is not arbitrary filesystem access using a history path.
    const values = await invoke("read_native_drop_contexts", { contextIds: [reference.attachmentId] });
    const file = values?.[0];
    if (!Array.isArray(values) || values.length !== 1 || file?.contextId !== reference.attachmentId) {
      throw new Error("Local attachment is missing or unavailable on this device.");
    }
    if (file.hostId !== reference.hostId) throw new Error("This attachment belongs to another host.");
    if (file.localPath !== reference.localPath || file.sha256 !== reference.sha256) {
      throw new Error("Local attachment does not match the saved reference.");
    }
    if (!file.mediaType?.startsWith("image/") || !file.dataBase64) {
      throw new Error("Local image preview is unavailable.");
    }
    const url = `data:${file.mediaType};base64,${file.dataBase64}`;
    // Conservative UTF-16 string accounting, including the reference key.
    const bytes = 2 * (url.length + key.length);
    if (bytes <= maxBytes) {
      while (retainedBytes + bytes > maxBytes && completed.size) {
        const oldest = completed.keys().next().value;
        retainedBytes -= completed.get(oldest).bytes;
        completed.delete(oldest);
      }
      completed.set(key, { url, bytes });
      retainedBytes += bytes;
    }
    return url;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
  };
}
