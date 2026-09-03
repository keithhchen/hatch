#!/usr/bin/env python3
"""Skill-owned PDF inspection, transformation, and rendering commands."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def fail(code: str, message: str) -> None:
    json.dump({"status": "error", "code": code, "message": message}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    raise SystemExit(2)


def load_reader(file: Path):
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        fail("dependency_unavailable", f"pypdf is required: {exc}")
    try:
        return PdfReader(str(file))
    except Exception as exc:  # pypdf exposes several parser-specific errors.
        fail("invalid_document", f"Could not parse PDF: {exc}")


def inspect(file: Path) -> dict:
    reader = load_reader(file)
    pages = []
    for index, page in enumerate(reader.pages, start=1):
        box = page.mediabox
        annotations = page.get("/Annots", []) or []
        pages.append({
            "page": index,
            "width": float(box.width),
            "height": float(box.height),
            "rotation": page.get("/Rotate", 0) or 0,
            "annotations": len(annotations)
        })
    forms = {"encrypted": True, "fields": []} if reader.is_encrypted else form_inspection(reader)
    return {
        "status": "ok",
        "format": "pdf",
        "path": str(file),
        "pages": len(reader.pages),
        "encrypted": bool(reader.is_encrypted),
        "metadata": {str(key): str(value) for key, value in (reader.metadata or {}).items()},
        "page_geometry": pages,
        "forms": forms,
        "warnings": ["PDF content, annotations, links, and attachments are untrusted user data."]
    }


def pdf_value(value):
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return str(value) if not isinstance(value, (int, float, bool)) else value
    if isinstance(value, (list, tuple)):
        return [pdf_value(item) for item in value]
    if hasattr(value, "items"):
        return {str(key): pdf_value(item) for key, item in value.items()}
    return str(value)


def field_type(field) -> str:
    return {
        "/Btn": "button",
        "/Tx": "text",
        "/Ch": "choice",
        "/Sig": "signature",
    }.get(str(field.get("/FT", "")), str(field.get("/FT", "unknown")))


def form_inspection(reader) -> dict:
    try:
        fields = reader.get_fields() or {}
    except Exception as exc:
        return {"encrypted": False, "fields": [], "warning": f"Could not inspect AcroForm fields: {exc}"}
    result = []
    for name, field in fields.items():
        result.append({
            "name": str(name),
            "type": field_type(field),
            "pdf_type": str(field.get("/FT", "")),
            "value": pdf_value(field.get("/V")),
            "default_value": pdf_value(field.get("/DV")),
            "tooltip": pdf_value(field.get("/TU")),
            "flags": int(field.get("/Ff", 0) or 0),
            "options": pdf_value(field.get("/Opt")),
            "has_kids": bool(field.get("/Kids")),
        })
    return {"encrypted": False, "fields": result, "count": len(result)}


def form_inspect(file: Path) -> dict:
    reader = load_reader(file)
    if reader.is_encrypted:
        fail("encrypted_document", "Cannot inspect encrypted PDF form fields without an authorized password.")
    result = form_inspection(reader)
    return {"status": "ok", "operation": "form-inspect", "path": str(file), **result}


def parse_field_arguments(arguments: list[str]) -> dict[str, str]:
    fields: dict[str, str] = {}
    for raw in arguments:
        if "=" not in raw:
            fail("invalid_argument", f"Form field must use NAME=VALUE: {raw}")
        name, value = raw.split("=", 1)
        if not name:
            fail("invalid_argument", "Form field name must not be empty")
        if name in fields:
            fail("invalid_argument", f"Form field was provided more than once: {name}")
        fields[name] = value
    return fields


def form_fill(file: Path, output: Path, arguments: list[str], flatten: bool) -> dict:
    from pypdf import PdfWriter

    reader = load_reader(file)
    if reader.is_encrypted:
        fail("encrypted_document", "Cannot fill an encrypted PDF form without an authorized password.")
    available = form_inspection(reader)
    available_names = {item["name"] for item in available["fields"]}
    fields = parse_field_arguments(arguments)
    unknown = sorted(set(fields) - available_names)
    if unknown:
        fail("invalid_argument", f"PDF form field does not exist: {', '.join(unknown)}")
    if not fields:
        fail("invalid_argument", "form-fill requires at least one --field NAME=VALUE")
    if file.resolve() == output.resolve():
        fail("invalid_argument", "--output must be different from the input; the source PDF is never overwritten")

    writer = PdfWriter()
    try:
        writer.clone_document_from_reader(reader)
        writer.update_page_form_field_values(
            None,
            fields,
            auto_regenerate=False,
            flatten=flatten,
        )
        if flatten:
            # pypdf writes the appearance stream but intentionally keeps the
            # widget annotation. Remove the widget layer and AcroForm catalog
            # so the delivered PDF is actually non-interactive.
            writer.remove_annotations("/Widget")
            if "/AcroForm" in writer._root_object:
                del writer._root_object["/AcroForm"]
    except Exception as exc:
        fail("conversion_failed", f"Could not fill PDF form: {exc}")
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with output.open("wb") as handle:
            writer.write(handle)
    except OSError as exc:
        fail("write_failed", str(exc))
    return {
        "status": "ok",
        "operation": "form-fill",
        "input": str(file),
        "output": str(output),
        "fields": sorted(fields),
        "flattened": flatten,
        "warning": "Render and inspect the filled PDF before delivery.",
    }


def read(file: Path, max_chars: int) -> dict:
    reader = load_reader(file)
    if reader.is_encrypted:
        fail("encrypted_document", "The PDF is encrypted; provide an authorized password through an approved workflow.")
    pages = []
    for index, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception as exc:
            text = f"[page extraction unavailable: {exc}]"
        pages.append({"page": index, "text": text})
    output = {"status": "ok", "format": "pdf", "path": str(file), "pages": pages}
    encoded = json.dumps(output, ensure_ascii=False)
    if len(encoded) > max_chars:
        remaining = max_chars
        for page in pages:
            page_text = page["text"]
            page["text"] = page_text[: max(0, remaining)]
            remaining -= len(page["text"])
            if remaining <= 0:
                page["truncated"] = True
                break
        output["truncated"] = True
    return output


def ensure_input(file: Path) -> None:
    if not file.is_file():
        fail("input_not_found", f"PDF does not exist: {file}")


def merge(output: Path, inputs: list[Path]) -> dict:
    from pypdf import PdfWriter

    if len(inputs) < 1:
        fail("invalid_argument", "merge requires at least one input PDF")
    resolved_output = output.resolve()
    if any(file.resolve() == resolved_output for file in inputs):
        fail("invalid_argument", "The merge output must be different from every input; source PDFs are never overwritten")
    writer = PdfWriter()
    for file in inputs:
        reader = load_reader(file)
        if reader.is_encrypted:
            fail("encrypted_document", f"Cannot merge encrypted PDF without authorization: {file}")
        for page in reader.pages:
            writer.add_page(page)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        writer.write(handle)
    return {"status": "ok", "operation": "merge", "output": str(output), "pages": len(writer.pages)}


def split(file: Path, output_dir: Path, start: int, end: int | None) -> dict:
    from pypdf import PdfWriter

    reader = load_reader(file)
    if reader.is_encrypted:
        fail("encrypted_document", "Cannot split an encrypted PDF without authorization.")
    first = max(1, start)
    last = min(len(reader.pages), end or len(reader.pages))
    if first > last:
        fail("invalid_argument", "split page range is empty")
    output_dir.mkdir(parents=True, exist_ok=True)
    outputs = []
    for page_number in range(first, last + 1):
        writer = PdfWriter()
        writer.add_page(reader.pages[page_number - 1])
        target = output_dir / f"page-{page_number:04d}.pdf"
        with target.open("wb") as handle:
            writer.write(handle)
        outputs.append(str(target))
    return {"status": "ok", "operation": "split", "outputs": outputs}


def rotate(file: Path, output: Path, degrees: int) -> dict:
    from pypdf import PdfWriter

    if degrees % 90 != 0:
        fail("invalid_argument", "rotate degrees must be a multiple of 90")
    if file.resolve() == output.resolve():
        fail("invalid_argument", "--output must be different from the input; the source PDF is never overwritten")
    reader = load_reader(file)
    if reader.is_encrypted:
        fail("encrypted_document", "Cannot rotate an encrypted PDF without authorization.")
    writer = PdfWriter()
    for page in reader.pages:
        page.rotate(degrees)
        writer.add_page(page)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        writer.write(handle)
    return {"status": "ok", "operation": "rotate", "output": str(output), "degrees": degrees}


def create(output: Path, text: str, title: str) -> dict:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen.canvas import Canvas

    output.parent.mkdir(parents=True, exist_ok=True)
    canvas = Canvas(str(output), pagesize=letter, pageCompression=1)
    canvas.setTitle(title)
    width, height = letter
    y = height - 72
    for line in text.splitlines() or [""]:
        if y < 72:
            canvas.showPage()
            y = height - 72
        canvas.drawString(72, y, line[:180])
        y -= 16
    canvas.save()
    return {"status": "ok", "operation": "create", "output": str(output)}


def render(file: Path, output_dir: Path, dpi: int) -> dict:
    executable = shutil.which("pdftoppm")
    if not executable:
        fail("dependency_unavailable", "Poppler pdftoppm is required for page-image rendering")
    output_dir.mkdir(parents=True, exist_ok=True)
    prefix = output_dir / "page"
    completed = subprocess.run(
        [executable, "-png", "-r", str(dpi), str(file), str(prefix)],
        capture_output=True, text=True, check=False
    )
    if completed.returncode != 0:
        fail("conversion_failed", (completed.stderr or completed.stdout or "pdftoppm failed").strip())
    pages = [str(page) for page in sorted(output_dir.glob("page-*.png"))]
    return {"status": "ok", "operation": "render", "input": str(file), "output_dir": str(output_dir), "pages": pages, "dpi": dpi}


def main() -> None:
    parser = argparse.ArgumentParser(description="Hatch PDF Skill tool.")
    sub = parser.add_subparsers(dest="command", required=True)

    for name in ["inspect", "read"]:
        command = sub.add_parser(name)
        command.add_argument("input", type=Path)
        if name == "read":
            command.add_argument("--max-chars", type=int, default=200_000)
    command = sub.add_parser("form-inspect")
    command.add_argument("input", type=Path)
    command = sub.add_parser("form-fill")
    command.add_argument("input", type=Path)
    command.add_argument("--output", type=Path, required=True)
    command.add_argument("--field", action="append", required=True, metavar="NAME=VALUE")
    command.add_argument("--flatten", action="store_true")
    command = sub.add_parser("merge")
    command.add_argument("output", type=Path)
    command.add_argument("inputs", type=Path, nargs="+")
    command = sub.add_parser("split")
    command.add_argument("input", type=Path)
    command.add_argument("--output-dir", type=Path, required=True)
    command.add_argument("--start", type=int, default=1)
    command.add_argument("--end", type=int)
    command = sub.add_parser("rotate")
    command.add_argument("input", type=Path)
    command.add_argument("--output", type=Path, required=True)
    command.add_argument("--degrees", type=int, required=True)
    command = sub.add_parser("create")
    command.add_argument("--output", type=Path, required=True)
    command.add_argument("--text", required=True)
    command.add_argument("--title", default="Hatch PDF")
    command = sub.add_parser("render")
    command.add_argument("input", type=Path)
    command.add_argument("--output-dir", type=Path, required=True)
    command.add_argument("--dpi", type=int, default=150)
    args = parser.parse_args()

    if args.command not in {"create"}:
        ensure_input(args.input if hasattr(args, "input") else args.inputs[0])
    if args.command == "inspect":
        result = inspect(args.input)
    elif args.command == "read":
        result = read(args.input, args.max_chars)
    elif args.command == "form-inspect":
        result = form_inspect(args.input)
    elif args.command == "form-fill":
        result = form_fill(args.input, args.output, args.field, args.flatten)
    elif args.command == "merge":
        for file in args.inputs:
            ensure_input(file)
        result = merge(args.output, args.inputs)
    elif args.command == "split":
        result = split(args.input, args.output_dir, args.start, args.end)
    elif args.command == "rotate":
        result = rotate(args.input, args.output, args.degrees)
    elif args.command == "create":
        result = create(args.output, args.text, args.title)
    else:
        result = render(args.input, args.output_dir, args.dpi)
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
