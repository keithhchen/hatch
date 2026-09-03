#!/usr/bin/env python3
"""Accept tracked changes in an OOXML Word package.

The operation is intentionally package-level so it preserves styles, media,
relationships, headers, footers, footnotes, and macros instead of rebuilding
the document through a lossy text model. Comments are preserved.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from lxml import etree


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = f"{{{W_NS}}}"
CHANGE_WRAPPERS = {
    f"{W}ins": "insertions_accepted",
    f"{W}moveTo": "moves_accepted",
}
CHANGE_REMOVALS = {
    f"{W}del": "deletions_removed",
    f"{W}moveFrom": "moves_removed",
}


def fail(code: str, message: str) -> None:
    json.dump({"status": "error", "code": code, "message": message}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    raise SystemExit(2)


def ensure_input(file: Path) -> None:
    if not file.is_file():
        fail("input_not_found", f"Word package does not exist: {file}")
    if file.suffix.lower() not in {".docx", ".dotx", ".docm", ".dotm"}:
        fail("unsupported_format", f"Tracked-change acceptance requires an OOXML Word package, not {file.suffix or 'this format'}")


def parse_xml(data: bytes, name: str) -> etree._Element:
    parser = etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        load_dtd=False,
        huge_tree=False,
        remove_blank_text=False,
    )
    try:
        return etree.fromstring(data, parser=parser)
    except etree.XMLSyntaxError as exc:
        fail("invalid_document", f"{name} contains invalid XML: {exc}")
    raise AssertionError("unreachable")


def rewrite_changes(root: etree._Element) -> dict[str, int]:
    counts = {
        "insertions_accepted": 0,
        "deletions_removed": 0,
        "moves_accepted": 0,
        "moves_removed": 0,
    }

    def visit(parent: etree._Element) -> None:
        for child in list(parent):
            if child.tag in CHANGE_REMOVALS:
                counts[CHANGE_REMOVALS[child.tag]] += 1
                parent.remove(child)
                continue
            if child.tag in CHANGE_WRAPPERS:
                counts[CHANGE_WRAPPERS[child.tag]] += 1
                # Process nested revisions before moving the accepted content
                # into the parent. This also handles malformed-but-readable
                # packages containing nested revision wrappers.
                visit(child)
                index = parent.index(child)
                tail = child.tail
                parent.remove(child)
                accepted_children = list(child)
                for nested in accepted_children:
                    child.remove(nested)
                    parent.insert(index, nested)
                    index += 1
                if accepted_children:
                    accepted_children[-1].tail = (accepted_children[-1].tail or "") + (tail or "")
                elif tail:
                    parent.text = (parent.text or "") + tail
                continue
            visit(child)

    visit(root)
    return counts


def remaining_change_counts(root: etree._Element) -> dict[str, int]:
    return {
        "insertions": len(root.xpath(".//w:ins", namespaces={"w": W_NS})),
        "deletions": len(root.xpath(".//w:del", namespaces={"w": W_NS})),
        "move_to": len(root.xpath(".//w:moveTo", namespaces={"w": W_NS})),
        "move_from": len(root.xpath(".//w:moveFrom", namespaces={"w": W_NS})),
    }


def output_xml(root: etree._Element) -> bytes:
    return etree.tostring(root, encoding="UTF-8", xml_declaration=True, standalone=False)


def accept_changes(source: Path, output: Path) -> dict[str, Any]:
    if source.resolve() == output.resolve():
        fail("invalid_argument", "--output must be different from the input; the source document is never overwritten")
    output.parent.mkdir(parents=True, exist_ok=True)
    totals = {
        "insertions_accepted": 0,
        "deletions_removed": 0,
        "moves_accepted": 0,
        "moves_removed": 0,
    }
    modified_parts: list[str] = []
    processed_parts = 0
    remaining: dict[str, int] = {"insertions": 0, "deletions": 0, "move_to": 0, "move_from": 0}

    temporary_name: str | None = None
    try:
        with zipfile.ZipFile(source, "r") as archive:
            temporary = tempfile.NamedTemporaryFile(
                prefix=f".{output.name}.",
                suffix=".tmp",
                dir=output.parent,
                delete=False,
            )
            temporary_name = temporary.name
            temporary.close()
            with zipfile.ZipFile(temporary_name, "w") as destination:
                for info in archive.infolist():
                    data = archive.read(info.filename)
                    has_revisions = any(token in data for token in (b":ins", b":del", b":moveTo", b":moveFrom"))
                    if info.filename.startswith("word/") and info.filename.endswith(".xml") and has_revisions:
                        root = parse_xml(data, info.filename)
                        counts = rewrite_changes(root)
                        for key, value in counts.items():
                            totals[key] += value
                        data = output_xml(root)
                        modified_parts.append(info.filename)
                        processed_parts += 1
                        current_remaining = remaining_change_counts(root)
                        for key, value in current_remaining.items():
                            remaining[key] += value
                    destination.writestr(info, data)
    except zipfile.BadZipFile as exc:
        if temporary_name:
            Path(temporary_name).unlink(missing_ok=True)
        fail("invalid_document", f"Not a valid OOXML Word package: {exc}")
    except OSError as exc:
        if temporary_name:
            Path(temporary_name).unlink(missing_ok=True)
        fail("write_failed", str(exc))
    except Exception:
        if temporary_name:
            Path(temporary_name).unlink(missing_ok=True)
        raise

    if temporary_name is None:
        fail("write_failed", "Could not create a temporary output package")
    try:
        os.replace(temporary_name, output)
    except OSError as exc:
        Path(temporary_name).unlink(missing_ok=True)
        fail("write_failed", str(exc))

    return {
        "status": "ok",
        "operation": "accept-changes",
        "input": str(source),
        "output": str(output),
        "processed_xml_parts": processed_parts,
        "modified_parts": modified_parts,
        **totals,
        "remaining_tracked_changes": remaining,
        "comments_preserved": True,
        "warning": "Accepting changes changes document content; render and validate the output before delivery.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Accept tracked changes in a Word OOXML package.")
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    ensure_input(args.input)
    result = accept_changes(args.input, args.output)
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
