import { expect, it, vi } from "vitest";
import { createLocalAttachmentImageReader, readLocalAttachmentImage } from "./local-attachment-preview.js";
const reference = { hostId: "host", attachmentId: "drop_image", localPath: "/managed/image.png", sha256: "hash" };
const file = { hostId: "host", contextId: "drop_image", localPath: "/managed/image.png", sha256: "hash",
  mediaType: "image/png", dataBase64: "aW1hZ2U=" };
it("deduplicates concurrent ID reads and does not send an arbitrary path to native", async () => {
  const invoke = vi.fn(async () => [file]);
  const first = readLocalAttachmentImage(invoke, reference);
  expect(readLocalAttachmentImage(invoke, { ...reference })).toBe(first);
  expect(await first).toBe("data:image/png;base64,aW1hZ2U=");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("read_native_drop_contexts", { contextIds: ["drop_image"] });
  await readLocalAttachmentImage(invoke, reference);
  expect(invoke).toHaveBeenCalledTimes(1);
});
it("rejects host, content and path mismatches without substituting a preview", async () => {
  for (const patch of [{ hostId: "other" }, { sha256: "changed" }, { localPath: "/other" }, { contextId: "other" }]) {
    await expect(readLocalAttachmentImage(async () => [{ ...file, ...patch }], reference)).rejects.toThrow();
  }
});
it("failed reads can be retried rather than caching failure", async () => {
  const invoke = vi.fn().mockRejectedValueOnce(new Error("missing")).mockResolvedValueOnce([file]);
  await expect(readLocalAttachmentImage(invoke, reference)).rejects.toThrow("missing");
  await expect(readLocalAttachmentImage(invoke, reference)).resolves.toContain("data:image/png");
});

it("evicts least recently used previews within the string budget", async () => {
  const invoke = vi.fn(async (_command, { contextIds }) => [{ ...file, contextId: contextIds[0] }]);
  const refs = ["a", "b", "c"].map((attachmentId) => ({ ...reference, attachmentId }));
  const url = `data:${file.mediaType};base64,${file.dataBase64}`;
  const entryBytes = 2 * (url.length + JSON.stringify([reference.hostId, "a", reference.localPath, reference.sha256]).length);
  const read = createLocalAttachmentImageReader(invoke, { maxBytes: entryBytes * 2 });
  await read(refs[0]);
  await read(refs[1]);
  await read(refs[0]); // A is now newer than B.
  await read(refs[2]);
  await read(refs[0]);
  expect(invoke).toHaveBeenCalledTimes(3);
  await read(refs[1]);
  expect(invoke).toHaveBeenCalledTimes(4);
});

it("does not retain oversized previews and never shares across native readers", async () => {
  const invoke = vi.fn(async () => [file]);
  const read = createLocalAttachmentImageReader(invoke, { maxBytes: 0 });
  await read(reference);
  await read(reference);
  expect(invoke).toHaveBeenCalledTimes(2);
  await expect(readLocalAttachmentImage(async () => [], reference)).rejects.toThrow();
});
