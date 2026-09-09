import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { LocalFileAttachmentSchema, persistedAttachment, renderUserMessageForModel, clientMessageInputDigest } from "./protocol.js";

const reference = {
  kind: "local_file" as const, attachment_id: "drop_document",
  host_id: "f780570c-7e50-4c14-bbd0-8a6c06d3302b",
  local_path: "/Users/example/Hatch/attachments/document.docx",
  display_name: "document.docx", media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  source_bytes: 10, sha256: "a".repeat(64)
};

test("local documents persist only references and reject uploaded bodies", () => {
  const parsed = LocalFileAttachmentSchema.parse(reference);
  assert.deepEqual(persistedAttachment(parsed), reference);
  assert.equal(LocalFileAttachmentSchema.safeParse({ ...reference, data_base64: "eA==" }).success, false);
  const rendered = renderUserMessageForModel({ content: "Read this", attachments: [parsed] });
  assert.ok(rendered.includes(reference.local_path));
  assert.ok(rendered.includes("complete Skill"));
  assert.ok(!rendered.includes("hatch_asset_text"));
  assert.notEqual(clientMessageInputDigest({ content: "Read this", attachments: [parsed] }),
    clientMessageInputDigest({ content: "Read this", attachments: [{ ...parsed, local_path: "/other/file.docx" }] }));
});

test("local image input validates actual bytes and strips them from attachment metadata", () => {
  const bytes = Buffer.from("image input bytes");
  const image = { ...reference, media_type: "image/png", source_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), data_base64: bytes.toString("base64") };
  const parsed = LocalFileAttachmentSchema.parse(image);
  assert.ok(!("data_base64" in persistedAttachment(parsed)));
  assert.equal(LocalFileAttachmentSchema.safeParse({ ...image, data_base64: undefined }).success, false);
  assert.equal(LocalFileAttachmentSchema.safeParse({ ...image, sha256: "b".repeat(64) }).success, false);
});

test("local references require a host and absolute platform path", () => {
  for (const local_path of ["relative.docx", "../file.docx", "/file\0.docx"]) {
    assert.equal(LocalFileAttachmentSchema.safeParse({ ...reference, local_path }).success, false);
  }
  assert.ok(LocalFileAttachmentSchema.safeParse({ ...reference, local_path: "C:\\Hatch\\attachments\\file.docx" }).success);
  assert.equal(LocalFileAttachmentSchema.safeParse({ ...reference, host_id: "unknown" }).success, false);
});
