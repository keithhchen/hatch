#!/usr/bin/env python3
"""Deterministic HTML to PDF renderer: full.pdf, free.pdf and preview.png, the first pages of the paid part blurred."""
import argparse
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

PAGE_W, PAGE_H, SCALE = 794, 1123, 2  # A4 at 96 dpi
BLUR_PX = 8
PREVIEW_PAGES = 3  # the first pages of the paid part, blurred, under the free part shown on the web
PREVIEW_CSS = (
    '[data-access="free"] { display: none !important; }'
    f'[data-access="paid"] {{ filter: blur({BLUR_PX}px) !important; }}'
)


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


def preview(browser, source: Path, out: Path) -> None:
    ctx = browser.new_context(viewport={"width": PAGE_W, "height": PAGE_H}, device_scale_factor=SCALE)
    offline(ctx)
    page = ctx.new_page()
    page.goto(source.resolve().as_uri(), wait_until="load")
    page.add_style_tag(content=PREVIEW_CSS)
    page.evaluate("document.fonts.ready")
    if page.locator('[data-access="paid"]').count() == 0:
        raise SystemExit("error: full.html has no [data-access=paid] section")
    height = min(page.evaluate("document.documentElement.scrollHeight"), PREVIEW_PAGES * PAGE_H)
    page.screenshot(path=str(out), full_page=True, clip={"x": 0, "y": 0, "width": PAGE_W, "height": height})
    ctx.close()


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
        preview(browser, full, out / "preview.png")
        browser.close()

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
