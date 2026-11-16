import { scopeKey, type Asset, type AssetBlobs, type AssetRepository, type AssetScope } from "./domain.js";
import { FILE_LIMITS, FileToolError, grepTexts, outlineOf, pageOf, type GrepQuery } from "./files.js";
import type { PdfPageRenderer } from "./pdfPages.js";
import type { AttachmentToolView, ToolOutput } from "./toolOutput.js";
import { ATTACHMENTS_ROOT } from "./views.js";

/** One addressable file: an original upload, or the text it was read as (`<name>.md`). */
type Flat = { path: string; asset: Asset; form: "original" | "text" };

const textOf = (asset: Asset) => asset.derivative("text") ?? asset.derivative("transcript");

/** "photo.jpg" taken twice becomes "photo (2).jpg": the later upload gets the suffix. */
function unique(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${base} (${n})${extension}`;
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
}

/**
 * Every asset uploaded to the conversation, attached to a message or not, oldest upload first, as /attachments/<name> and, for each that has a text form,
 * /attachments/<name>.md.
 */
export function flatEntries(all: readonly Asset[]): Flat[] {
  const assets = [...all]
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt) || a.id.localeCompare(b.id));
  const taken = new Set<string>();
  const originals = assets.map((asset) => ({ asset, name: unique(asset.record.name, taken) }));
  return originals.flatMap(({ asset, name }) => [
    { path: `${ATTACHMENTS_ROOT}/${name}`, asset, form: "original" as const },
    ...textOf(asset) ? [{ path: `${ATTACHMENTS_ROOT}/${unique(`${name}.md`, taken)}`, asset, form: "text" as const }] : []
  ]);
}

/**
 * The attachments of a report conversation, read-only and flat: the client's files by their own names. A text form is
 * read as text, an image is seen, a PDF is seen page by page. The scope comes from the conversation, never from the model.
 */
export class FlatAttachmentFiles implements AttachmentToolView {
  constructor(private readonly repository: AssetRepository, private readonly blobs: AssetBlobs, private readonly pdf: PdfPageRenderer) {}

  async count(scope: AssetScope): Promise<number> { return (await this.repository.listScope(scope)).length; }

  private async entries(scope: AssetScope): Promise<Flat[]> { return flatEntries(await this.repository.listScope(scope)); }

  private async find(scope: AssetScope, path: string): Promise<Flat> {
    if (typeof path !== "string" || /[\0\\]/.test(path)) throw new FileToolError("Invalid path");
    const found = (await this.entries(scope)).find((entry) => entry.path === path.replace(/\/+$/, ""));
    if (!found) throw new FileToolError(`No such file: ${path}. Use ls for the paths.`);
    return found;
  }

  private text(entry: Flat): Promise<string | undefined> {
    const derivative = textOf(entry.asset);
    return derivative ? this.blobs.get(derivative.key).then((bytes) => bytes.toString("utf8")) : Promise.resolve(undefined);
  }

  private line({ path, asset, form }: Flat): string {
    const derivative = textOf(asset);
    return form === "text" ? `${path}  text  ${derivative!.bytes} bytes` : `${path}  ${asset.record.mime}  ${asset.record.bytes} bytes`;
  }

  async ls(scope: AssetScope, path = ATTACHMENTS_ROOT): Promise<string> {
    const entries = await this.entries(scope);
    const wanted = path.replace(/\/+$/, "") || ATTACHMENTS_ROOT;
    const selected = wanted === ATTACHMENTS_ROOT ? entries : entries.filter((entry) => entry.path === wanted);
    if (wanted !== ATTACHMENTS_ROOT && !selected.length) throw new FileToolError(`No such file: ${path}`);
    const lines = selected.map((entry) => this.line(entry));
    const only = wanted !== ATTACHMENTS_ROOT ? selected[0] : undefined;
    if (only?.form === "text") lines.push(...outlineOf((await this.text(only))!));
    const shown = lines.slice(0, FILE_LIMITS.lsEntries);
    return [...shown, ...lines.length > shown.length ? [`... ${lines.length - shown.length} more`] : []].join("\n") || "(empty)";
  }

  async grep(scope: AssetScope, query: GrepQuery): Promise<string> {
    const texts = (await this.entries(scope)).filter((entry) => entry.form === "text" && (!query.path || query.path === ATTACHMENTS_ROOT || entry.path === query.path));
    return grepTexts(texts.map((entry) => ({ path: entry.path, text: () => this.text(entry) })), query);
  }

  async readTool(scope: AssetScope, args: { path: string; offset?: number; page?: number }): Promise<ToolOutput> {
    const { offset = 0, page = 1 } = args;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(page) || page < 1) throw new FileToolError("offset and page must be positive integers");
    const entry = await this.find(scope, args.path);
    if (entry.form === "text") return JSON.stringify(pageOf(entry.path, (await this.text(entry))!, offset, FILE_LIMITS.readChars));
    const { asset } = entry;
    if (asset.record.kind === "image") {
      const resized = asset.derivative("resized");
      if (!resized) throw new FileToolError("This image has no viewable form");
      return { text: `${entry.path} (image)`, image: { mimeType: resized.mime, data: (await this.blobs.get(resized.key)).toString("base64") } };
    }
    if (asset.record.mime === "application/pdf") {
      const rendered = await this.pdf.render(await this.blobs.get(`${scopeKey(scope)}/${asset.record.sha256}/original`), page);
      return { text: `${entry.path}, page ${rendered.page} of ${rendered.pages}${rendered.page < rendered.pages ? `. Call read again with page=${rendered.page + 1} for the next page.` : ""}`, image: { mimeType: "image/png", data: rendered.png.toString("base64") } };
    }
    const asText = (await this.entries(scope)).find((other) => other.asset.id === asset.id && other.form === "text");
    throw new FileToolError(asText ? `This original is not shown as is. Read ${asText.path} for its text.` : "This file has no readable form here");
  }
}
