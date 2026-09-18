import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { detectMediaType, projectSource } from "../creatorLearning/sourceLibrary.js";
import { result } from "./files.js";
import { WorkbenchStore } from "./store.js";

/** Main agents see live outputs and immutable input during a turn. */
export function fileTools(store: WorkbenchStore, id: string, options: { changed?: () => void } = {}): AgentTool[] {
  const records = async () => store.contextFiles(id);
  const tools: AgentTool[] = [
    { name: "list", label: "查看文件", description: "List this Agent's own input/output files plus live upstream outputs projected under input/<agent>/. Upstream files are read-only and never copied.", parameters: Type.Object({ directory: Type.Optional(Type.String({ description: "Workspace directory such as input/manual, input/research, input/voice, input/evaluator, or output." })) }), execute: async (_id, raw) => { const a = raw as { directory?: string }; const directory = a.directory?.replace(/\/+$/, ""); return result((await records()).filter(f => !directory || directory === "." || f.path.startsWith(`${directory}/`)).map(({ path, bytes, mimeType, readonly, origin }) => ({ path, bytes, mimeType, readonly, source: origin?.path }))); } },
    { name: "read", label: "读取文件", description: "Read a file by character offset. Follow next_offset until null. Original files are unchanged; Office/PDF extraction is explicitly labelled.", parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 24000 })) }), execute: async (_id, raw) => {
      const a = raw as { path: string; offset?: number; limit?: number };
      const record = (await records()).find(f => f.path === a.path);
      if (!record) throw new Error("File not available in this context");
      const { bytes } = await store.read(id, record.path);
      const mimeType = detectMediaType(a.path, record.mimeType === "application/octet-stream" ? undefined : record.mimeType, bytes);
      if (mimeType.startsWith("image/")) return { content: [{ type: "image" as const, data: bytes.toString("base64"), mimeType }], details: { path: a.path } };
      if (/\.(mp3|mp4|wav|m4a|mov|webm|ogg)$/i.test(a.path)) throw new Error("Media requires transcribe tool; original media is retained");
      const plain = /\.(md|txt|srt|vtt|log)$/i.test(a.path);
      const projection = plain ? undefined : await projectSource(a.path, mimeType, bytes);
      const text = plain ? bytes.toString("utf8") : (projection as { __content?: string }).__content;
      if (typeof text !== "string") throw new Error("Document has no readable text projection");
      const offset = a.offset ?? 0;
      const end = Math.min(text.length, offset + (a.limit ?? 16000));
      return result({ path: a.path, representation: plain ? "original_text" : "extracted_text_original_retained", total_characters: text.length, offset, next_offset: end < text.length ? end : null, content: text.slice(offset, end) });
    } }
  ];
  tools.push({ name: "write", label: "写入 Markdown", description: "Save one actual output/*.md file. Read an existing file before editing it. Writing the same path replaces its current contents. A failed call means nothing was saved. Input files and Runtime results are read-only.", parameters: Type.Object({ path: Type.String(), content: Type.String({ minLength: 1 }) }), execute: async (_id, raw) => {
    const a = raw as { path: string; content: string };
    const record = await store.put(id, a.path, Buffer.from(a.content), { actor: "agent" });
    options.changed?.();
    return result({ path: record.path, bytes: record.bytes, saved: true });
  } });
  return tools;
}
