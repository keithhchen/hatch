#!/usr/bin/env python3
"""Validate the structural integrity of a DOCX ZIP package."""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


def fail(code: str, message: str) -> None:
    json.dump({"status": "error", "code": code, "message": message}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    raise SystemExit(2)


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate a DOCX package.")
    parser.add_argument("input", type=Path)
    args = parser.parse_args()
    if not args.input.is_file():
        fail("input_not_found", f"DOCX does not exist: {args.input}")

    required = {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}
    try:
        with zipfile.ZipFile(args.input) as archive:
            names = set(archive.namelist())
            missing = sorted(required - names)
            if missing:
                fail("invalid_document", f"DOCX is missing required parts: {', '.join(missing)}")
            parsed = 0
            for name in sorted(names):
                if name.endswith(".xml") or name.endswith(".rels"):
                    ET.fromstring(archive.read(name))
                    parsed += 1
            macros = sorted(name for name in names if name.startswith("word/vba"))
            external_relationships = []
            for name in names:
                if not name.endswith(".rels"):
                    continue
                root = ET.fromstring(archive.read(name))
                external_relationships.extend(
                    relationship.attrib.get("Target", "")
                    for relationship in root
                    if relationship.attrib.get("TargetMode") == "External"
                )
    except zipfile.BadZipFile as exc:
        fail("invalid_document", f"Not a valid DOCX ZIP package: {exc}")
    except ET.ParseError as exc:
        fail("invalid_document", f"DOCX contains invalid XML: {exc}")
    except OSError as exc:
        fail("read_failed", str(exc))

    result = {
        "status": "ok",
        "format": "docx",
        "path": str(args.input),
        "zip_entries": len(names),
        "xml_parts_parsed": parsed,
        "macro_parts": macros,
        "external_relationships": external_relationships,
        "warnings": (["The package contains macros; they were not executed."] if macros else [])
    }
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
