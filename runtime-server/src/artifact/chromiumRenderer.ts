import type { Browser } from "playwright-core";
import sharp from "sharp";
import { PdfParsePageRenderer } from "../assets/pdfPages.js";
import type { RenderedReport, ReportRenderer } from "./ports.js";

/** Pages after the first shown blurred under page 1 on the web. */
export const PREVIEW_PAGES = 3;
const PAGE_WIDTH_PX = 794; // A4 at 96 dpi
const BLUR_SIGMA = 7;
const PAGE_GAP_PX = 16;
const RENDER_TIMEOUT_MS = 120_000;

const PRINT = { format: "A4", printBackground: true, preferCSSPageSize: true } as const;

/**
 * The report's HTML printed by headless Chromium inside the Runtime: full.pdf; free.pdf, its first page; and preview.png,
 * page 1 as printed with the next pages blurred under it. One render at a time, each in a fresh browser that loads nothing
 * but the document itself, and ended at a deadline.
 */
export class ChromiumReportRenderer implements ReportRenderer {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: { timeoutMs?: number; launch?: () => Promise<Browser>; pages?: PdfParsePageRenderer } = {}) {}

  render(input: { fullHtml: string }, signal?: AbortSignal): Promise<RenderedReport> {
    const run = this.queue.then(() => this.once(input.fullHtml, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async once(html: string, signal?: AbortSignal): Promise<RenderedReport> {
    signal?.throwIfAborted();
    const browser = await (this.options.launch ?? defaultLaunch)();
    const deadline = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(this.options.timeoutMs ?? RENDER_TIMEOUT_MS)]);
    const closed = new Promise<never>((_, reject) => deadline.addEventListener("abort", () => {
      void browser.close();
      reject(new Error("Rendering the report took too long"));
    }, { once: true }));
    try {
      return await Promise.race([closed, (async () => {
        const context = await browser.newContext();
        // Self-contained by contract: nothing but the document and data: URLs may load.
        await context.route("**/*", (route) => route.request().url().startsWith("data:") ? route.continue() : route.abort());
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: "load" });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const fullPdf = await page.pdf(PRINT);
        const freePdf = await page.pdf({ ...PRINT, pageRanges: "1" });
        return { fullPdf, freePdf, preview: await this.preview(fullPdf) };
      })()]);
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  /** Page 1 as printed, then the next pages blurred, stacked with a transparent gap. */
  private async preview(fullPdf: Buffer): Promise<Buffer> {
    const pages = this.options.pages ?? new PdfParsePageRenderer(PAGE_WIDTH_PX);
    const first = await pages.render(fullPdf, 1);
    if (first.pages < 2) throw new Error("The report has only one page; it needs at least one page after the first");
    const shots = [first.png];
    for (let n = 2; n <= Math.min(first.pages, 1 + PREVIEW_PAGES); n += 1) {
      shots.push(await sharp((await pages.render(fullPdf, n)).png).blur(BLUR_SIGMA).png().toBuffer());
    }
    const sizes = await Promise.all(shots.map((png) => sharp(png).metadata()));
    const width = Math.max(...sizes.map((s) => s.width ?? 0));
    let top = 0;
    const layers = shots.map((input, i) => { const layer = { input, top, left: 0 }; top += (sizes[i]!.height ?? 0) + PAGE_GAP_PX; return layer; });
    return sharp({ create: { width, height: top - PAGE_GAP_PX, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toBuffer();
  }
}

/** The headless shell Playwright installs (PLAYWRIGHT_BROWSERS_PATH in the image), or HATCH_CHROMIUM_PATH. */
async function defaultLaunch(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const executablePath = process.env.HATCH_CHROMIUM_PATH?.trim();
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}
