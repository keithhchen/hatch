#!/usr/bin/env python3
"""Deterministic HTML to PDF renderer: full.pdf, free.pdf, and preview.png: the paid part's first printed pages, blurred."""
import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

PREVIEW_PAGES = 3  # the first pages of the paid part, blurred, shown on the web under the free pages
PREVIEW_DPI, BLUR_RADIUS, PAGE_GAP = 96, 7, 16

def find(root: Path, name: str) -> Path:
    hits = sorted(p for p in root.rglob(name) if p.is_file())
    if not hits:
        raise SystemExit(f"error: {name} not found under {root}")
    return hits[0]


def offline(ctx) -> None:
    """The report is self-contained: nothing but local files and data: URLs may load."""
    ctx.route("**/*", lambda route: route.continue_() if route.request.url.startswith(("file:", "data:")) else route.abort())


def pdf(page, source: Path, out: Path) -> None:
    page.goto(source.resolve().as_uri(), wait_until="load")
    page.evaluate("document.fonts.ready")
    page.pdf(path=str(out), format="A4", print_background=True, prefer_css_page_size=True)


def preview(full_pdf: Path, free_pdf: Path, out: Path) -> None:
    """The paid part's first pages as they print: the full PDF's pages after the free ones, blurred, stacked with a gap."""
    from PIL import Image, ImageFilter
    first = page_count(free_pdf) + 1
    last = min(page_count(full_pdf), first + PREVIEW_PAGES - 1)
    if first > last:
        raise SystemExit("error: full.pdf has no pages after the free part")
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdftoppm", "-r", str(PREVIEW_DPI), "-png", "-f", str(first), "-l", str(last), str(full_pdf), f"{tmp}/p"], check=True)
        pages = [Image.open(p).convert("RGB").filter(ImageFilter.GaussianBlur(BLUR_RADIUS)) for p in sorted(Path(tmp).glob("p*.png"))]
    width = max(p.width for p in pages)
    sheet = Image.new("RGBA", (width, sum(p.height for p in pages) + PAGE_GAP * (len(pages) - 1)), (0, 0, 0, 0))
    y = 0
    for page in pages:
        sheet.paste(page, (0, y))
        y += page.height + PAGE_GAP
    sheet.save(out, optimize=True)


def page_count(path: Path) -> int:
    data = path.read_bytes()
    try:
        from pypdf import PdfReader
        return len(PdfReader(str(path)).pages)
    except ImportError:
        return len(re.findall(rb"/Type\s*/Page[^s]", data))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--upload", default="/mnt/agents")
    ap.add_argument("--output", default="/mnt/agents/output")
    args = ap.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    full, free = find(Path(args.upload), "full.html"), find(Path(args.upload), "free.html")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context()
        offline(ctx)
        page = ctx.new_page()
        pdf(page, full, out / "full.pdf")
        pdf(page, free, out / "free.pdf")
        ctx.close()
        browser.close()
    preview(out / "full.pdf", out / "free.pdf", out / "preview.png")

    result = {}
    for name in ("full.pdf", "free.pdf", "preview.png"):
        f = out / name
        if not f.is_file() or f.stat().st_size < 1000:
            raise SystemExit(f"error: {name} is missing or empty")
        result[name] = {"bytes": f.stat().st_size, **({"pages": page_count(f)} if name.endswith(".pdf") else {})}
    (out / "result.json").write_text(json.dumps(result, indent=2))
    for name in (*result, "result.json"):
        print(f"SAVE {name}")


if __name__ == "__main__":
    sys.exit(main())
