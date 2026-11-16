import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { corpusOutputSchema, type CorpusOutput } from "../creatorLearning/corpusSchema.js";
import { parseSkillMarkdown } from "../skills.js";
import { repairSkillSource, runtimeId } from "../creatorLearning/productLive/adapters/workbenchDefinitions.js";
import { result, digest } from "./files.js";
import { WorkbenchStore, type FactoryProductScope } from "./store.js";

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
  return [{
    name: "corpus_upload", label: "上传可执行 Corpus", description: "Read saved output SYSTEM.md and selected skills/references, assemble the existing Corpus schema and publish it to this workspace's Product through the Product Registry API. The host fixes the Product; this tool cannot select or create one. Skill paths look like output/skills/<name>/SKILL.md with references under output/skills/<name>/references/. Only output/SYSTEM.md is required: names are repaired automatically, and any file that cannot be read is skipped and listed in skipped so you can fix it and upload again; formatting never blocks the upload. Tool declarations come from host configuration. Re-upload after definition edits. No target Agent execution here.",
    parameters: Type.Object({
      skills: Type.Optional(Type.Array(Type.Object({ path: Type.String(), references: Type.Optional(Type.Array(Type.Object({ path: Type.String(), kind: Type.Optional(Type.String({ description: "method (working procedure), style (communication style), example (worked example) or few_shots (input/output demonstrations); anything else is treated as method." })) }))) }))),
    }),
    execute: async (_call, raw, signal) => {
      const a = raw as { skills?: Array<{ path: string; references?: Array<{ path: string; kind?: string }> }> };
      // Completion over quality: anything repairable is repaired, anything else is skipped
      // and reported back to the Builder. Only SYSTEM.md is required.
      const skipped: string[] = [];
      let s = await store.get(id);
      if (s.role !== "generation") throw new Error("Only Agent Generation may upload a Corpus");
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
      let corpus: CorpusOutput;
      let reply: z.infer<typeof corpusReceiptSchema>;
      try {
        corpus = corpusOutputSchema.parse({ system_instructions: system, skills, tools: JSON.parse(env.HATCH_FACTORY_TARGET_TOOLS_JSON ?? "[]") });
        reply = corpusReceiptSchema.parse(await registryRequest(env, `/v1/creator/products/${encodeURIComponent(product.productId)}/registry`, { corpus }, signal));
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : "Corpus publication failed");
      }
      if (reply.product_id !== product.productId || reply.corpus_digest !== digest(JSON.stringify(corpus))) throw new Error("Published Product or Corpus digest does not match the uploaded definition");
      const receipt = { ...reply, creator_id: product.creatorId, files };
      await store.update(id, state => { state.corpus = receipt; });
      const published = { product_id: reply.product_id, status: reply.status, published_at: reply.published_at, files };
      changed(); return result(skipped.length ? { ...published, skipped } : published);
    },
  }, {
    name: "product_card", label: "Agent 店面信息", description: "Read or overwrite this Agent's storefront card: name, promise, and the opening questions clients answer before the chat. Call with no fields to read. Fields you pass replace the current ones; fields you omit stay as they are. The host fixes the Agent; this tool cannot select or create one.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Storefront name: short, names the job this Agent does. No expert name or marketing filler." })),
      promise: Type.Optional(Type.String({ description: "One or two customer-facing sentences stating who this helps, when, and what valuable result it delivers. No methods, evidence, feature lists, boundaries, or disclaimers." })),
      opening_questions: Type.Optional(Type.Array(Type.Object({ label: Type.String(), required: Type.Optional(Type.Boolean()) }), { minItems: 1, maxItems: 5, description: "1–5 questions the client answers before the chat starts: only facts the Agent needs first and the client can answer immediately." })),
    }),
    execute: async (_call, raw, signal) => {
      // Setting the card is naturally idempotent; the key only makes one call's retries one write, never replays an older call.
      const key = randomUUID();
      const a = raw as { name?: string; promise?: string; opening_questions?: Array<{ label: string; required?: boolean }> };
      if ((await store.get(id)).role !== "generation") throw new Error("Only the agent builder may change the storefront card");
      const route = `/v1/creator/products/${encodeURIComponent(product.productId)}`;
      const name = a.name?.trim().slice(0, 240), promise = a.promise?.trim();
      if (name || promise) {
        const body = { ...(name ? { name } : {}), ...(promise ? { promise } : {}) };
        const updated = z.object({ product_id: z.string().uuid() }).passthrough().parse(await registryRequest(env, route, body, signal, `factory-card-${id}-${key}`, "PATCH"));
        if (updated.product_id !== product.productId) throw new Error("Registry updated a different Product");
      }
      const fields = (a.opening_questions ?? []).map(question => ({ label: String(question.label ?? "").trim().slice(0, 500), required: question.required !== false })).filter(question => question.label).slice(0, 5).map((question, index) => ({ id: `q${index + 1}`, ...question }));
      if (fields.length) await registryRequest(env, `${route}/brief-spec`, { brief_spec: { contract_version: "1", fields } }, signal, `factory-brief-${id}-${key}`, "PUT");
      const current = (await registryRequest(env, route) as { product: { name: string; promise: string; brief_spec?: { fields?: Array<{ label: string; required: boolean }> } } }).product;
      return result({ name: current.name, promise: current.promise, opening_questions: (current.brief_spec?.fields ?? []).map(({ label, required }) => ({ label, required })) });
    },
  }];
}
