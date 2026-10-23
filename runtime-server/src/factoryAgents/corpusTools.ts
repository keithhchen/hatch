import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { corpusOutputSchema, type CorpusOutput } from "../creatorLearning/corpusNode.js";
import { parseSkillMarkdown } from "../skills.js";
import { repairSkillSource, runtimeId } from "../creatorLearning/productLive/adapters/workbenchDefinitions.js";
import { result, digest } from "./files.js";
import { samePath, WorkbenchStore, type FactoryProductScope } from "./store.js";

const REFERENCE_KINDS = ["method", "style", "example", "few_shots"] as const;
type ReferenceKind = typeof REFERENCE_KINDS[number];
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const corpusReceiptSchema = z.object({
  product_id: z.string().uuid(), corpus_ref: z.string().min(1), corpus_digest: hash,
  release_digest: hash, status: z.literal("published"), published_at: z.string().datetime(),
});

/** HTTP adapter only. Auth, file projection, validation, indexing and release stay in Registry. */
export async function registryRequest(env: NodeJS.ProcessEnv, route: string, body?: unknown, signal?: AbortSignal, idempotencyKey?: string, method?: "POST" | "PATCH" | "PUT"): Promise<unknown> {
  const base = env.HATCH_FACTORY_REGISTRY_URL;
  const token = env.HATCH_FACTORY_CREATOR_TOKEN;
  if (!base || !token) throw new Error("Corpus unavailable: configure HATCH_FACTORY_REGISTRY_URL and HATCH_FACTORY_CREATOR_TOKEN");
  const url = new URL(base);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("Registry requires TLS or loopback");
  const response = await fetch(new URL(route, url), {
    method: body === undefined ? "GET" : (method ?? "POST"), redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(900000)]) : AbortSignal.timeout(900000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string }; detail?: string };
    throw new Error(`Registry HTTP ${response.status}${payload.error?.code ? ` (${payload.error.code})` : ""}${payload.error?.message || payload.detail ? `: ${String(payload.error?.message ?? payload.detail).slice(0, 1200)}` : ""}; no success receipt was recorded`);
  }
  return response.json();
}

export function corpusTools(store: WorkbenchStore, id: string, changed: () => void, scope: FactoryProductScope, env: NodeJS.ProcessEnv = process.env): AgentTool[] {
  const product = Object.freeze({ creatorId: scope.creatorId, productId: scope.productId });
  const uploadKnowledge = async (a: { path: string; title: string; reason: string }, signal?: AbortSignal) => {
      const s = await store.get(id);
      if (s.role !== "generation") throw new Error("Only Agent Generation may upload Knowledge");
      if (!a.path.startsWith("input/")) throw new Error("Knowledge must select original input files; generated output is not an original");
      const { record, bytes } = await store.read(id, a.path);
      const contentHash = digest(bytes);
      const old = s.knowledge?.find(k => k.productId === product.productId && k.path === a.path && k.sha256 === contentHash);
      if (old) return old;
      const endpoint = `/v1/creator/products/${encodeURIComponent(product.productId)}/files`;
      const reply = z.object({ id: z.string().min(1), product_id: z.string(), path: z.string(), sha256: z.string(), projection: z.object({ kind: z.literal("markdown") }) }).parse(await registryRequest(env, endpoint, {
        display_name: path.posix.basename(a.path), media_type: record.mimeType,
        content_base64: bytes.toString("base64"), sha256: contentHash,
        selection_reason: a.reason, metadata: { factory_session: id, input_path: a.path },
      }, signal, `factory-${digest(`${id}:${a.path}:${contentHash}`).slice(7)}`));
      if (reply.product_id !== product.productId || reply.sha256.replace(/^sha256:/, "") !== contentHash.slice(7)) throw new Error("Registry upload identity/digest mismatch");
      const entry = { path: a.path, id: reply.id, source: reply.path, title: a.title, productId: reply.product_id, sha256: contentHash };
      await store.update(id, state => { state.knowledge = [...(state.knowledge ?? []), entry]; });
      changed();
      return entry;
  };
  return [{
    name: "corpus_upload", label: "上传可执行 Corpus", description: "Pass title (storefront name), promise and opening_questions (the short form clients fill in before the chat) for the Product, then read saved output SYSTEM.md and selected skills/references, assemble the existing Corpus schema and publish it to this workspace's Product through the Product Registry API. The host fixes the Product; this tool cannot select or create one. Skill paths look like output/skills/<name>/SKILL.md with references under output/skills/<name>/references/. Only output/SYSTEM.md is required: names are repaired automatically, and any file that cannot be read is skipped and listed in skipped so you can fix it and upload again; formatting never blocks the upload. Tool declarations come from host configuration. Saves CORPUS.md with the actual publication status. Re-upload after definition edits. No target Agent execution here.",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Storefront title: short, names the job this Agent does. No Creator name or marketing filler. Omit only to keep the current title." })),
      opening_questions: Type.Optional(Type.Array(Type.Object({ label: Type.String(), required: Type.Optional(Type.Boolean()) }), { description: "1–5 questions the client answers before the chat starts: only facts the Agent needs first and the client can answer immediately. Omit only to keep the current questions." })),
      promise: Type.Optional(Type.String({ description: "One or two customer-facing sentences stating who this helps, when, and what valuable result it delivers. No methods, evidence, feature lists, boundaries, or disclaimers." })),
      skills: Type.Optional(Type.Array(Type.Object({ path: Type.String(), references: Type.Optional(Type.Array(Type.Object({ path: Type.String(), kind: Type.Optional(Type.String({ description: "method (working procedure), style (communication style), example (worked example) or few_shots (input/output demonstrations); anything else is treated as method." })) }))) }))),
    }),
    execute: async (_call, raw, signal) => {
      const a = raw as { title?: string; opening_questions?: Array<{ label: string; required?: boolean }>; promise?: string; skills?: Array<{ path: string; references?: Array<{ path: string; kind?: string }> }>; knowledge?: Array<{ path: string; title: string; reason: string }> };
      // Completion over quality: anything repairable is repaired, anything else is skipped
      // and reported back to the Builder. Only SYSTEM.md is required.
      const skipped: string[] = [];
      let s = await store.get(id);
      if (s.role !== "generation") throw new Error("Only Agent Generation may upload a Corpus");
      // Knowledge comes from the same view the agent lists: shared input/manual
      // files and upstream projections, not only this session's own files.
      const inputs = await store.contextFiles(id);
      // Knowledge is hidden from the agent until retrieval is rebuilt; the
      // selection path stays for callers that still pass it explicitly.
      const selections = [...new Map((a.knowledge ?? []).flatMap(doc => {
        const file = inputs.find(f => samePath(f.path, doc.path) && f.path.startsWith("input/"));
        if (!file) { skipped.push(`${doc.path}: not an input file`); return []; }
        return [[file.path, { ...doc, path: file.path }] as const];
      })).values()];
      const files: string[] = [];
      const read = async (name: string) => {
        if (!name.startsWith("output/") || !name.endsWith(".md")) throw new Error("Definition files must be saved output Markdown");
        const entry = s.files.find(f => f.path === name);
        if (!entry) throw new Error(`Missing definition file: ${name}`);
        const { bytes } = await store.read(id, name);
        files.push(name); return bytes.toString("utf8");
      };
      const skills: CorpusOutput["skills"] = [];
      for (const skill of a.skills ?? []) {
        try {
          const repaired = repairSkillSource(await read(skill.path), path.posix.basename(path.posix.dirname(skill.path)));
          if (skills.some(existing => existing.id === repaired.id)) continue;
          const parsed = parseSkillMarkdown(repaired.source);
          const refs: CorpusOutput["skills"][number]["references"] = [];
          for (const ref of skill.references ?? []) {
            try {
              const refId = runtimeId(path.posix.basename(ref.path, ".md"));
              if (!refId || refs.some(existing => existing.id === refId)) continue;
              const content = await read(ref.path);
              if (!content.trim()) continue;
              refs.push({ id: refId, kind: REFERENCE_KINDS.includes(ref.kind as ReferenceKind) ? ref.kind as ReferenceKind : "method", content });
            } catch (error) { skipped.push(`${ref.path}: ${reason(error)}`); }
          }
          skills.push({ id: parsed.manifest.name, title: parsed.manifest.name, when_to_use: parsed.manifest.description, instruction: parsed.instructions, references: refs });
        } catch (error) { skipped.push(`${skill.path}: ${reason(error)}`); }
      }
      const system = await read("output/SYSTEM.md").catch(() => { throw new Error("Write output/SYSTEM.md first; it is the only file the upload requires."); });
      const title = a.title?.trim().slice(0, 240);
      const promise = a.promise?.trim() || (title ? (await registryRequest(env, `/v1/creator/products/${encodeURIComponent(product.productId)}`) as { product?: { promise?: string } }).product?.promise : undefined);
      if (promise) {
        const updated = z.object({ product_id: z.string().uuid() }).passthrough().parse(await registryRequest(env, `/v1/creator/products/${encodeURIComponent(product.productId)}`, { promise, ...(title ? { name: title } : {}) }, signal, `factory-promise-${id}-${digest(`${title ?? ""}\n${promise}`).slice(7)}`, "PATCH"));
        if (updated.product_id !== product.productId) throw new Error("Registry updated a different Product");
      }
      const questions = (a.opening_questions ?? []).map(question => ({ label: String(question.label ?? "").trim().slice(0, 500), required: question.required !== false })).filter(question => question.label).slice(0, 16);
      if (questions.length) {
        const fields = questions.map((question, index) => ({ id: `q${index + 1}`, label: question.label, required: question.required }));
        await registryRequest(env, `/v1/creator/products/${encodeURIComponent(product.productId)}/brief-spec`, { brief_spec: { contract_version: "1", fields } }, signal, `factory-brief-${id}-${digest(JSON.stringify(fields)).slice(7)}`, "PUT");
      }
      const knowledge: CorpusOutput["knowledge"] = [];
      let corpus: CorpusOutput;
      let reply: z.infer<typeof corpusReceiptSchema>;
      try {
        for (const doc of selections) {
          const uploaded = await uploadKnowledge(doc, signal);
          files.push(uploaded.path);
          knowledge.push({ source: uploaded.source, title: doc.title });
        }
        corpus = corpusOutputSchema.parse({ system_instructions: system, skills, knowledge, tools: JSON.parse(env.HATCH_FACTORY_TARGET_TOOLS_JSON ?? "[]") });
        reply = corpusReceiptSchema.parse(await registryRequest(env, `/v1/creator/products/${encodeURIComponent(product.productId)}/registry`, { corpus }, signal));
      } catch (error) {
        const entries = (await store.get(id)).knowledge ?? [];
        const uploaded = selections.map(doc => entries.find(k => k.path === doc.path && k.productId === product.productId)).filter(Boolean);
        throw new Error(`${error instanceof Error ? error.message : "Corpus publication failed"}\nOriginal files already uploaded (publication/indexing not confirmed): ${JSON.stringify(uploaded)}`);
      }
      if (reply.product_id !== product.productId || reply.corpus_digest !== digest(JSON.stringify(corpus))) throw new Error("Published Product or Corpus digest does not match the uploaded definition");
      const uploadedKnowledge = (await store.get(id)).knowledge ?? [];
      const receipt = { ...reply, creator_id: product.creatorId, files, knowledge: selections.map(doc => ({ ...uploadedKnowledge.find(k => k.path === doc.path && k.productId === product.productId)!, status: "indexed" })) };
      await store.update(id, state => { state.corpus = receipt; });
      const published = { product_id: reply.product_id, status: reply.status, published_at: reply.published_at, files };
      await store.put(id, "output/CORPUS.md", Buffer.from(`# Agent 已发布\n\n\`\`\`json\n${JSON.stringify(published, null, 2)}\n\`\`\`\n`), { actor: "host", readonly: true });
      changed(); return result(skipped.length ? { ...published, skipped } : published);
    },
  }];
}
