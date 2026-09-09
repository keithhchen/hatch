import { createHash, randomUUID } from "node:crypto";
import { writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export const digest = (content: string | Buffer) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
export const result = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], details: {} });
export async function atomicWrite(file: string, content: string | Buffer): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
