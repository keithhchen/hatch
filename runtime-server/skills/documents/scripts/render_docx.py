#!/usr/bin/env python3
"""Render a DOCX to PDF and, when Poppler exists, page PNGs."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def fail(code: str, message: str) -> None:
    json.dump({"status": "error", "code": code, "message": message}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    raise SystemExit(2)


def main() -> None:
    parser = argparse.ArgumentParser(description="Render a DOCX for visual QA.")
    parser.add_argument("input", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--pdf-only", action="store_true")
    args = parser.parse_args()
    if not args.input.is_file():
        fail("input_not_found", f"DOCX does not exist: {args.input}")
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        fail("dependency_unavailable", "LibreOffice (soffice) is required to render DOCX")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="hatch-docx-profile-") as profile:
        environment = os.environ.copy()
        environment["HOME"] = profile
        environment["TMPDIR"] = profile
        command = [
            soffice, "--headless", "--nologo", "--nodefault", "--nolockcheck", "--norestore",
            f"-env:UserInstallation={Path(profile).as_uri()}",
            "--convert-to", "pdf", "--outdir", str(args.output_dir), str(args.input)
        ]
        completed = subprocess.run(command, capture_output=True, text=True, env=environment, check=False)
    if completed.returncode != 0:
        fail("conversion_failed", (completed.stderr or completed.stdout or "LibreOffice failed").strip())
    pdf = args.output_dir / f"{args.input.stem}.pdf"
    if not pdf.is_file():
        fail("conversion_failed", f"LibreOffice did not produce {pdf}")
    pages: list[str] = []
    pdftoppm = shutil.which("pdftoppm")
    if not args.pdf_only and pdftoppm:
        prefix = args.output_dir / "page"
        render = subprocess.run(
            [pdftoppm, "-png", str(pdf), str(prefix)],
            capture_output=True, text=True, check=False
        )
        if render.returncode != 0:
            fail("conversion_failed", (render.stderr or render.stdout or "pdftoppm failed").strip())
        pages = [str(file) for file in sorted(args.output_dir.glob("page-*.png"))]
    result = {
        "status": "ok",
        "input": str(args.input),
        "pdf": str(pdf),
        "pages": pages,
        "visual_inspection_required": True,
        "renderer": "LibreOffice" + (" + Poppler" if pages else "")
    }
    if not pdftoppm and not args.pdf_only:
        result["warning"] = "Poppler pdftoppm is unavailable; inspect the generated PDF itself."
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
