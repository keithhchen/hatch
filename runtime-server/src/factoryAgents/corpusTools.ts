import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { corpusOutputSchema, type CorpusOutput } from "../creatorLearning/corpusNode.js";
import { parseSkillMarkdown } from "../skills.js";
import { result, digest } from "./files.js";
import { WorkbenchStore, type FactoryProductScope } from "./store.js";

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const corpusReceiptSchema = z.object({
  product_id: z.string().uuid(), corpus_ref: z.string().min(1), corpus_digest: hash,
  release_digest: hash, status: z.literal("published"), published_at: z.string().datetime(),
});

/** HTTP adapter only. Auth, file projection, validation, indexing and release stay in Registry. */
export async function registryRequest(env: NodeJS.ProcessEnv, route: string, body?: unknown, signal?: AbortSignal, idempotencyKey?: string, method?: "POST" | "PATCH"): Promise<unknown> {
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
    name: "corpus_upload", label: "上传可执行 Corpus", description: "Read saved output SYSTEM.md and selected skills/references, assemble the existing Corpus schema and publish it to this workspace's Product through the Product Registry API. The host fixes the Product; this tool cannot select or create one. Select whole original input files as Knowledge; the tool uploads unchanged bytes. Skill paths must include output/: output/skills/<name>/SKILL.md and output/skills/<name>/references/<id>.md. Reference kind is exactly method, style, example, or few_shots. Tool declarations come from host configuration. Saves CORPUS.md with the actual publication status. Re-upload after definition edits. No target Agent execution here.",
    parameters: Type.Object({
      promise: Type.String({ minLength: 1, maxLength: 280, description: "One or two customer-facing sentences stating who this helps, when, and what valuable result it delivers. No methods, evidence, feature lists, boundaries, or disclaimers." }),
      skills: Type.Array(Type.Object({ path: Type.String(), references: Type.Array(Type.Object({ path: Type.String(), kind: Type.Union([Type.Literal("method"), Type.Literal("style"), Type.Literal("example"), Type.Literal("few_shots")], { description: "One of: method (working procedure), style (communication style), example (worked example), few_shots (input/output demonstrations)." }) })) })),
      knowledge: Type.Array(Type.Object({ path: Type.String(), title: Type.String({ minLength: 1, maxLength: 256 }), reason: Type.String({ minLength: 1, maxLength: 2000 }) })),
    }),
    execute: async (_call, raw, signal) => {
      const a = raw as { promise: string; skills: Array<{ path: string; references: Array<{ path: string; kind: "method" | "style" | "example" | "few_shots" }> }>; knowledge: Array<{ path: string; title: string; reason: string }> };
      let s = await store.get(id);
      if (s.role !== "generation") throw new Error("Only Agent Generation may upload a Corpus");
      const selections = a.knowledge.map(doc => {
        const file = s.files.find(f => f.path === doc.path);
        if (!file) throw new Error(`File not found: ${doc.path}`);
        return doc;
      });
      const files: string[] = [];
      const read = async (name: string) => {
        if (!name.startsWith("output/") || !name.endsWith(".md")) throw new Error("Definition files must be saved output Markdown");
        const entry = s.files.find(f => f.path === name);
        if (!entry) throw new Error(`Missing definition file: ${name}`);
        const { bytes } = await store.read(id, name);
        files.push(name); return bytes.toString("utf8");
      };
      const skills: CorpusOutput["skills"] = [];
      for (const skill of a.skills) {
        const parsed = parseSkillMarkdown(await read(skill.path));
        if (skill.path !== `output/skills/${parsed.manifest.name}/SKILL.md`) throw new Error("Skill name must match output/skills/<name>/SKILL.md");
        const refs: CorpusOutput["skills"][number]["references"] = [];
        for (const ref of skill.references) {
          const refId = path.posix.basename(ref.path, ".md");
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(refId)) throw new Error("Reference filename must use lowercase letters, numbers and hyphens");
          if (ref.path !== `output/skills/${parsed.manifest.name}/references/${refId}.md`) throw new Error("Store references inside the Skill so relative links survive Runtime loading");
          refs.push({ id: refId, kind: ref.kind, content: await read(ref.path) });
        }
        if (new Set(refs.map(r => r.id)).size !== refs.length) throw new Error("Duplicate Skill reference");
        skills.push({ id: parsed.manifest.name, title: parsed.manifest.name, when_to_use: parsed.manifest.description, instruction: parsed.instructions, references: refs });
      }
      if (new Set(skills.map(k => k.id)).size !== skills.length || new Set(selections.map(k => k.path)).size !== selections.length) throw new Error("Duplicate Skill or Knowledge selection");
      const system = await read("output/SYSTEM.md");
      for (const doc of selections) {
        if (!doc.path.startsWith("input/")) throw new Error("Knowledge must be original input files");
        await store.read(id, doc.path);
      }
      const updated = z.object({ product_id: z.string().uuid() }).passthrough().parse(await registryRequest(env, `/v1/creator/products/${encodeURIComponent(product.productId)}`, { promise: a.promise }, signal, `factory-promise-${id}-${digest(a.promise).slice(7)}`, "PATCH"));
      if (updated.product_id !== product.productId) throw new Error("Registry updated a different Product");
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
      const published = { product_id: reply.product_id, status: reply.status, published_at: reply.published_at, files, knowledge: receipt.knowledge.map(({ path, id, title, status }) => ({ path, id, title, status })) };
      await store.put(id, "output/CORPUS.md", Buffer.from(`# Agent 已发布\n\n\`\`\`json\n${JSON.stringify(published, null, 2)}\n\`\`\`\n`), { actor: "host", readonly: true });
      changed(); return result(published);
    },
  }];
}
