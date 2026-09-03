#!/usr/bin/env python3
"""Convert an Office document with the installed LibreOffice CLI."""

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
    parser = argparse.ArgumentParser(description="Convert an Office file using LibreOffice.")
    parser.add_argument("input", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--format", required=True, choices=["pdf", "docx", "xlsx", "pptx", "odt", "html"])
    args = parser.parse_args()
    if not args.input.is_file():
        fail("input_not_found", f"Input does not exist: {args.input}")
    expected = args.output_dir / f"{args.input.stem}.{args.format}"
    if args.input.resolve() == expected.resolve():
        fail("invalid_argument", "--output-dir would overwrite the input; choose a separate output directory")
    executable = shutil.which("soffice") or shutil.which("libreoffice")
    if not executable:
        fail("dependency_unavailable", "LibreOffice (soffice) is required for Office conversion")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="hatch-office-profile-") as profile:
        environment = os.environ.copy()
        environment["HOME"] = profile
        environment["TMPDIR"] = profile
        command = [
            executable,
            "--headless",
            "--nologo",
            "--nodefault",
            "--nolockcheck",
            "--norestore",
            f"-env:UserInstallation={Path(profile).as_uri()}",
            "--convert-to",
            args.format,
            "--outdir",
            str(args.output_dir),
            str(args.input)
        ]
        completed = subprocess.run(command, capture_output=True, text=True, env=environment, check=False)
    if completed.returncode != 0:
        fail("conversion_failed", (completed.stderr or completed.stdout or "LibreOffice failed").strip())
    if not expected.is_file():
        fail("conversion_failed", f"LibreOffice did not produce {expected}")
    json.dump({
        "status": "ok",
        "input": str(args.input),
        "output": str(expected),
        "format": args.format,
        "stdout": completed.stdout.strip()
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
