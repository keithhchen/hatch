import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { log } from "../observability/log.js";
import { digest, result } from "./files.js";
import type { WorkbenchStore } from "./store.js";

export const IMAGE_MODELS = { "text-to-image": "openai/gpt-image-2.6/flare/text-to-image", edit: "openai/gpt-image-2.6/flare/edit" } as const;
export const IMAGE_SIZES = ["square_hd", "square", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9", "auto"] as const;
/** The model's own input (fal's field names); for edit, image_urls holds data URIs. */
export type ImageRequest = { mode: keyof typeof IMAGE_MODELS; input: Record<string, unknown> };
export type GeneratedImage = { bytes: Buffer; contentType: string };

/** The provider's error text keeps its meaning but never its names: vendor and model ids stay in code, config and logs. */
export const scrub = (message: string): string => message
  .replace(/https?:\/\/[^\s"']*(?:fal\.(?:run|ai|media)|falrun\.com)[^\s"']*/gi, "[service]")
  .replace(/\b(?:openai\/)?gpt-image[\w./-]*/gi, "[model]")
  .replace(/\bopenai\b|\bfal(?:\.ai)?\b/gi, "[service]");
/** Errors from the image service (its own {detail, error_type}, 422 {detail:[…]}, 429 shapes), without vendor names. */
export class FalError extends Error { constructor(message: string) { super(scrub(message)); } }

/** fal Queue API: submit, poll the returned status_url, fetch the returned response_url, download at once (results expire). */
export class FalImageGenerator {
  constructor(private readonly key: string, private readonly fetcher: typeof globalThis.fetch = globalThis.fetch, private readonly options: { pollMs?: number; timeoutMs?: number } = {}) {}
  private headers(extra: Record<string, string> = {}) { return { authorization: `Key ${this.key}`, "content-type": "application/json", ...extra }; }
  private async json(response: Response, what: string): Promise<Record<string, unknown>> {
    const raw = await response.text();
    if (!response.ok && response.status !== 202) throw new FalError(`fal ${what} failed (${response.status}): ${raw.slice(0, 1500)}`);
    return raw ? JSON.parse(raw) as Record<string, unknown> : {};
  }
  async generate(input: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage[]> {
    const body = input.input;
    const submitted = await this.json(await this.fetcher(`https://queue.fal.run/${IMAGE_MODELS[input.mode]}`, { method: "POST", headers: this.headers({ "x-fal-request-start-timeout": "120" }), body: JSON.stringify(body), signal }), "submit");
    const statusUrl = String(submitted.status_url ?? ""), responseUrl = String(submitted.response_url ?? "");
    if (!statusUrl || !responseUrl) throw new FalError(`fal submit returned no status_url/response_url: ${JSON.stringify(submitted).slice(0, 500)}`);
    const deadline = Date.now() + (this.options.timeoutMs ?? 300_000);
    for (;;) {
      const status = await this.json(await this.fetcher(statusUrl, { headers: this.headers(), signal }), "status");
      if (status.status === "COMPLETED") break;
      if (Date.now() > deadline) throw new FalError(`fal request ${String(submitted.request_id)} did not complete in time`);
      await new Promise(resolve => setTimeout(resolve, this.options.pollMs ?? 2000));
    }
    // A failed or cancelled request is also COMPLETED: the result says so.
    const output = await this.json(await this.fetcher(responseUrl, { headers: this.headers(), signal }), "result");
    const images = Array.isArray(output.images) ? output.images as Array<{ url?: string; content_type?: string }> : [];
    if (!images.length) throw new FalError(`fal returned no images: ${JSON.stringify(output).slice(0, 1500)}`);
    return Promise.all(images.map(async image => {
      const response = await this.fetcher(String(image.url), { signal });
      if (!response.ok) throw new FalError(`fal image download failed (${response.status})`);
      return { bytes: Buffer.from(await response.arrayBuffer()), contentType: image.content_type || "image/jpeg" };
    }));
  }
}

export class ImageUnavailableError extends Error {
  readonly code = "image_unavailable";
  readonly status = 503;
}
export const imageGeneratorFrom = (env: NodeJS.ProcessEnv, fetcher?: typeof globalThis.fetch): FalImageGenerator => {
  const key = env.FAL_KEY?.trim();
  if (!key) { log.error("image_unavailable", { reason: "missing key", env: "FAL_KEY" }); throw new ImageUnavailableError("Image generation is unavailable: it is not configured on this server."); }
  return new FalImageGenerator(key, fetcher);
};

const mimeOf = (file: string) => /\.png$/i.test(file) ? "image/png" : /\.webp$/i.test(file) ? "image/webp" : "image/jpeg";
const EXTENSION: Record<string, string> = { jpeg: "jpg", png: "png", webp: "webp" };
const QUALITY = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
const literals = <T extends readonly string[]>(values: T) => values.map(value => Type.Literal(value));

/** Parameters mirror the two fal models 1:1 (verified from their API pages); input_images are workspace paths that become image_urls. */
export function imageTool(store: WorkbenchStore, id: string, changed: () => void, generator: FalImageGenerator): AgentTool {
  return {
    name: "generate_image", label: "生成图片",
    description: [
      "Generate or edit an image and save it under output/images/. Returns the saved paths.",
      "mode 'text-to-image': draw from prompt. mode 'edit': edit or compose from input_images following prompt.",
      "Parameters: prompt (required, <=32000 chars; put any text that must appear in the image inside it, verbatim). input_images (edit only, required, 1-16 workspace paths of images already in the node folder; used as the source images). image_size: preset square_hd | square | portrait_4_3 | portrait_16_9 | landscape_4_3 | landscape_16_9 | auto (auto infers from inputs; default landscape_4_3 for text-to-image, auto for edit) or {width,height} with both multiples of 16, max edge 3840, aspect ratio <=3:1, total pixels 655,360-8,294,400.",
      "quality: auto|low|medium|high|xhigh|max (default high). reasoning_effort: low|medium|high (default high; more planning for dense text and layouts, slower). background: auto|transparent|opaque (default auto; transparent needs output_format png or webp). num_images: 1-10 (default 1). output_format: jpeg|png|webp (default jpeg here).",
      "Xiaohongshu cover and carousel cards: portrait_4_3. Square cards and Instagram: square_hd. Vertical video cover: portrait_16_9. Wide header: landscape_16_9.",
    ].join("\n"),
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 32000 }),
      mode: Type.Union(literals(["text-to-image", "edit"] as const)),
      input_images: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 16 })),
      image_size: Type.Optional(Type.Union([...literals(IMAGE_SIZES), Type.Object({ width: Type.Integer({ minimum: 16 }), height: Type.Integer({ minimum: 16 }) })])),
      quality: Type.Optional(Type.Union(literals(QUALITY))),
      reasoning_effort: Type.Optional(Type.Union(literals(["low", "medium", "high"] as const))),
      background: Type.Optional(Type.Union(literals(["auto", "transparent", "opaque"] as const))),
      num_images: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      output_format: Type.Optional(Type.Union(literals(["jpeg", "png", "webp"] as const))),
    }),
    execute: async (_call, raw, signal) => {
      const { mode, input_images, ...params } = raw as { mode: ImageRequest["mode"]; input_images?: string[]; output_format?: string } & Record<string, unknown>;
      const output_format = params.output_format ?? "jpeg";
      const input: Record<string, unknown> = { ...params, output_format };
      if (mode === "edit") {
        if (!input_images?.length) throw new Error("mode edit needs input_images");
        // Data URIs are accepted by fal for image inputs; no separate storage upload is needed.
        input.image_urls = await Promise.all(input_images.map(async file => `data:${mimeOf(file)};base64,${(await store.read(id, file)).bytes.toString("base64")}`));
      }
      const images = await generator.generate({ mode, input }, AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(360_000)]));
      const saved: string[] = [];
      for (const image of images) saved.push((await store.put(id, `output/images/image-${digest(image.bytes).slice(7, 19)}.${EXTENSION[output_format] ?? "jpg"}`, image.bytes, { actor: "host", mimeType: image.contentType })).path);
      changed();
      return result({ paths: saved });
    },
  };
}
