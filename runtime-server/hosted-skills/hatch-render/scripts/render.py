#!/usr/bin/env python3
"""Deterministic HTML to PDF renderer: full.pdf; free.pdf, its first page; preview.png, page 1 clear and the next pages blurred."""
import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

PREVIEW_PAGES = 3  # pages after the first, blurred, shown on the web under page 1
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


def first_page(full_pdf: Path, out: Path) -> None:
    """free.pdf is the full report's first page, nothing else."""
    from pypdf import PdfReader, PdfWriter
    writer = PdfWriter()
    writer.add_page(PdfReader(str(full_pdf)).pages[0])
    with open(out, "wb") as f:
        writer.write(f)


def preview(full_pdf: Path, out: Path) -> None:
    """What the web shows: page 1 as printed, then the next pages blurred, stacked with a gap."""
    from PIL import Image, ImageFilter
    last = min(page_count(full_pdf), 1 + PREVIEW_PAGES)
    if last < 2:
        raise SystemExit("error: full.pdf has only one page")
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdftoppm", "-r", str(PREVIEW_DPI), "-png", "-f", "1", "-l", str(last), str(full_pdf), f"{tmp}/p"], check=True)
        files = sorted(Path(tmp).glob("p*.png"))
        pages = [Image.open(files[0]).convert("RGB")] + [Image.open(p).convert("RGB").filter(ImageFilter.GaussianBlur(BLUR_RADIUS)) for p in files[1:]]
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
    ap.add_argument("--full", required=True, help="the uploaded report's file name; unique per render, because the upload folder keeps earlier files")
    ap.add_argument("--upload", default="/mnt/agents/upload")
    ap.add_argument("--output", required=True, help="a folder of this render's own")
    args = ap.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    full = find(Path(args.upload), args.full)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context()
        offline(ctx)
        page = ctx.new_page()
        pdf(page, full, out / "full.pdf")
        ctx.close()
        browser.close()
    first_page(out / "full.pdf", out / "free.pdf")
    preview(out / "full.pdf", out / "preview.png")

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
