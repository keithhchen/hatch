import { FileToolError } from "./matchers.js";

export type PdfPage = { png: Buffer; page: number; pages: number };

/** Renders one page of a PDF as an image, so a model can see what the text layer does not carry (a scan, a table's layout). */
export interface PdfPageRenderer {
  render(pdf: Buffer, page: number): Promise<PdfPage>;
}

/** Every page of a PDF as an image, in order. */
export interface PdfAllPagesRenderer {
  renderAll(pdf: Buffer): Promise<Buffer[]>;
}

/**
 * pdf-parse is already a dependency (it reads PDF text at upload) and renders with pdf.js on @napi-rs/canvas, which ships
 * prebuilt binaries for linux x64 and arm64 glibc: no new package, no system library, nothing to install in the image.
 */
export class PdfParsePageRenderer implements PdfPageRenderer, PdfAllPagesRenderer {
  constructor(private readonly width = 1100) {}

  async renderAll(pdf: Buffer): Promise<Buffer[]> {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(pdf) });
    try {
      const shot = await parser.getScreenshot({ desiredWidth: this.width, imageBuffer: true, imageDataUrl: false });
      return shot.pages.map((page) => Buffer.from(page.data));
    } catch (error) {
      throw new FileToolError(`This PDF could not be rendered: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }

  async render(pdf: Buffer, page: number): Promise<PdfPage> {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(pdf) });
    try {
      const shot = await parser.getScreenshot({ partial: [page], desiredWidth: this.width, imageBuffer: true, imageDataUrl: false });
      const found = shot.pages[0];
      if (!found) throw new FileToolError(`This PDF has ${shot.total} page${shot.total === 1 ? "" : "s"}; there is no page ${page}`);
      return { png: Buffer.from(found.data), page, pages: shot.total };
    } catch (error) {
      if (error instanceof FileToolError) throw error;
      throw new FileToolError(`This PDF could not be rendered: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }
}
