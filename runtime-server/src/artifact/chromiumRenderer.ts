import type { Browser } from "playwright-core";
import { PdfParsePageRenderer } from "../assets/pdfPages.js";
import type { RenderedReport, ReportRenderer } from "./ports.js";

// A4 at 192 dpi: sharp on a phone or a retina screen, where the image is drawn at about 400–800 CSS pixels wide.
const PAGE_WIDTH_PX = 1588;
const RENDER_TIMEOUT_MS = 120_000;

const PRINT = { format: "A4", printBackground: true, preferCSSPageSize: true } as const;

/**
 * A report document printed by headless Chromium inside the Runtime: its PDF, the page count, and page 1 as an image. Each
 * render in a fresh browser that loads nothing but the document itself, and ended at a deadline.
 */
export class ChromiumReportRenderer implements ReportRenderer {
  constructor(private readonly options: { timeoutMs?: number; launch?: () => Promise<Browser>; pages?: PdfParsePageRenderer } = {}) {}

  render(html: string, signal?: AbortSignal): Promise<RenderedReport> {
    return this.once(html, signal);
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
        const pdf = await page.pdf(PRINT);
        const first = await (this.options.pages ?? new PdfParsePageRenderer(PAGE_WIDTH_PX)).render(pdf, 1);
        return { pdf, pages: first.pages, firstPagePng: first.png };
      })()]);
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}

/** The headless shell Playwright installs (PLAYWRIGHT_BROWSERS_PATH in the image), or HATCH_CHROMIUM_PATH. */
async function defaultLaunch(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const executablePath = process.env.HATCH_CHROMIUM_PATH?.trim();
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}
