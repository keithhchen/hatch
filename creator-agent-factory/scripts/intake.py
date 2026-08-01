#!/usr/bin/env python3
"""Normalize a Creator's raw course directory without requiring configuration.

This stage is deliberately semantic-free. It preserves originals, extracts
readable text with provenance, and reports media capabilities. The Agent
executing the Creator Agent Factory Skill reads the complete extracted corpus
and performs the semantic distillation directly.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


TEXT_EXTENSIONS = {".md", ".txt", ".rst", ".csv", ".tsv", ".json", ".yaml", ".yml"}
SUBTITLE_EXTENSIONS = (".vtt", ".srt")
MEDIA_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".mp3", ".m4a", ".wav", ".aac", ".flac", ".aiff"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm"}
TIMECODE_RE = re.compile(
    r"(?P<start>(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*(?P<end>(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})"
)


class IntakeError(RuntimeError):
    pass


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value.replace("\r\n", "\n").replace("\r", "\n").strip() + "\n", encoding="utf-8")


def command_path(name: str) -> str | None:
    return shutil.which(name)


def safe_relative_files(root: Path) -> list[Path]:
    result = []
    for path in root.rglob("*"):
        if not path.is_file() or any(part.startswith(".") for part in path.relative_to(root).parts):
            continue
        result.append(path)
    return sorted(result, key=lambda p: p.relative_to(root).as_posix().lower())


def source_id(relative: Path) -> str:
    stem = re.sub(r"[^a-z0-9]+", "-", relative.with_suffix("").as_posix().lower()).strip("-")
    suffix = digest_bytes(relative.as_posix().encode())[:8]
    return f"src-{stem[:48]}-{suffix}"


def run_checked(command: list[str], *, timeout: int = 900) -> str:
    result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        message = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise IntakeError(f"extractor failed ({' '.join(command[:2])}): {message}")
    return result.stdout


def find_sidecar(path: Path) -> Path | None:
    for suffix in SUBTITLE_EXTENSIONS:
        candidate = path.with_suffix(suffix)
        if candidate.is_file():
            return candidate
    return None


def timecode_seconds(value: str) -> float:
    pieces = value.replace(",", ".").split(":")
    if len(pieces) == 2:
        hours, minutes, seconds = 0, float(pieces[0]), float(pieces[1])
    else:
        hours, minutes, seconds = float(pieces[0]), float(pieces[1]), float(pieces[2])
    return hours * 3600 + minutes * 60 + seconds


def transcript_provenance(text: str, transcript_path: Path, media_duration: float | None) -> dict:
    segments = [
        {"start_seconds": timecode_seconds(match.group("start")), "end_seconds": timecode_seconds(match.group("end"))}
        for match in TIMECODE_RE.finditer(text)
    ]
    if not segments:
        raise IntakeError(f"transcript contains no timestamped segments: {transcript_path.name}")
    if any(segment["end_seconds"] <= segment["start_seconds"] for segment in segments):
        raise IntakeError(f"transcript contains a non-positive segment: {transcript_path.name}")
    if any(current["start_seconds"] < previous["end_seconds"] for previous, current in zip(segments, segments[1:])):
        raise IntakeError(f"transcript segments overlap or run backwards: {transcript_path.name}")
    final_end = segments[-1]["end_seconds"]
    if media_duration is not None and final_end > media_duration + 0.5:
        raise IntakeError(
            f"transcript ends at {final_end:.3f}s after media duration {media_duration:.3f}s: {transcript_path.name}"
        )
    raw = transcript_path.read_bytes()
    return {
        "path": transcript_path.name,
        "sha256": digest_bytes(raw),
        "segment_count": len(segments),
        "first_start_seconds": segments[0]["start_seconds"],
        "final_end_seconds": final_end,
        "media_duration_seconds": media_duration,
        "segments_within_media": media_duration is None or final_end <= media_duration + 0.5,
    }


def split_pdf_pages(value: str, path: Path) -> list[str]:
    pages = value.replace("\r\n", "\n").replace("\r", "\n").split("\f")
    while pages and not pages[-1].strip():
        pages.pop()
    if not pages or not any(page.strip() for page in pages):
        raise IntakeError(f"PDF contains no extractable page text: {path.name}")
    return [page.strip() for page in pages]


def render_pdf_pages(pages: list[str], relative: Path) -> tuple[str, dict]:
    blocks = []
    page_records = []
    for page_number, page in enumerate(pages, 1):
        location = f"{relative.as_posix()}#page={page_number}"
        marker = f"source-location: {location}"
        blocks.append(f"<!-- {marker} -->\n## PDF page {page_number}\n\n{page}")
        page_records.append({
            "page_number": page_number,
            "location": location,
            "extracted_marker": marker,
            "text_sha256": digest_bytes((page + "\n").encode()),
            "extracted_characters": len(page + "\n"),
            "has_extractable_text": bool(page),
        })
    return "\n\n".join(blocks), {"page_count": len(pages), "pages": page_records}


def extract_pdf(path: Path) -> tuple[list[str], str]:
    binary = command_path("pdftotext")
    if not binary:
        raise IntakeError("PDF input found but pdftotext is unavailable")
    raw = run_checked([binary, "-layout", str(path), "-"])
    return split_pdf_pages(raw, path), "pdftotext -layout with page boundaries"


def extract_media(path: Path, output: Path, policy: str) -> tuple[str, str, Path | None]:
    sidecar = find_sidecar(path)
    if sidecar:
        return sidecar.read_text(encoding="utf-8", errors="replace"), f"sidecar {sidecar.suffix[1:].upper()}", sidecar
    if policy == "sidecar-only":
        raise IntakeError(f"media has no .vtt/.srt sidecar under sidecar-only policy: {path.name}")
    whisper = command_path("whisper")
    ffmpeg = command_path("ffmpeg")
    if not whisper or not ffmpeg:
        missing = ", ".join(name for name, value in (("whisper", whisper), ("ffmpeg", ffmpeg)) if not value)
        raise IntakeError(f"media transcription unavailable ({missing}); provide a sidecar transcript or install the missing tool")
    transcript_dir = output / ".transcription"
    transcript_dir.mkdir(parents=True, exist_ok=True)
    model = "tiny" if policy == "auto" else "small"
    run_checked([
        whisper, str(path), "--model", model, "--output_dir", str(transcript_dir),
        "--output_format", "vtt", "--verbose", "False",
    ], timeout=3600)
    transcript = transcript_dir / f"{path.stem}.vtt"
    if not transcript.is_file():
        raise IntakeError(f"whisper completed without producing transcript for {path.name}")
    return transcript.read_text(encoding="utf-8"), f"whisper {model}", None


def media_metadata(path: Path) -> dict:
    ffprobe = command_path("ffprobe")
    if not ffprobe:
        return {}
    try:
        raw = run_checked([
            ffprobe, "-v", "error", "-show_entries", "format=duration",
            "-show_entries", "stream=codec_type,codec_name,width,height",
            "-of", "json", str(path),
        ], timeout=60)
        return json.loads(raw)
    except (IntakeError, json.JSONDecodeError):
        return {}


def intake(input_dir: Path, intent: str, output: Path, media_policy: str = "auto") -> dict:
    input_dir = input_dir.resolve()
    output = output.resolve()
    if not input_dir.is_dir():
        raise IntakeError(f"input directory does not exist: {input_dir}")
    if not intent.strip():
        raise IntakeError("product intent must be a non-empty sentence")
    if output.exists():
        raise IntakeError(f"output already exists: {output}")

    staging = Path(tempfile.mkdtemp(prefix="creator-intake-")) / "workspace"
    try:
        raw_root = staging / "raw"
        extracted_root = staging / "extracted"
        files = safe_relative_files(input_dir)
        subtitle_sidecars = {sidecar.resolve() for path in files if path.suffix.lower() in MEDIA_EXTENSIONS for sidecar in [find_sidecar(path)] if sidecar}
        records = []
        unsupported = []

        for path in files:
            relative = path.relative_to(input_dir)
            raw = path.read_bytes()
            raw_destination = raw_root / relative
            raw_destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, raw_destination)
            extension = path.suffix.lower()
            if path.resolve() in subtitle_sidecars:
                continue

            text = None
            extractor = None
            attached_sidecar = None
            kind = None
            metadata = {}
            if extension in TEXT_EXTENSIONS or extension in SUBTITLE_EXTENSIONS:
                text = raw.decode("utf-8", errors="replace")
                extractor = "utf-8 text"
                kind = "subtitle" if extension in SUBTITLE_EXTENSIONS else "text"
            elif extension == ".pdf":
                pages, extractor = extract_pdf(path)
                text, metadata = render_pdf_pages(pages, relative)
                kind = "pdf"
            elif extension in MEDIA_EXTENSIONS:
                text, extractor, attached_sidecar = extract_media(path, staging, media_policy)
                kind = "video" if extension in VIDEO_EXTENSIONS else "audio"
                metadata = media_metadata(path)
            else:
                unsupported.append({
                    "path": relative.as_posix(), "bytes": len(raw), "sha256": digest_bytes(raw),
                    "reason": f"unsupported extension {extension or '(none)'}",
                })
                continue

            sid = source_id(relative)
            normalized = f"# Extracted source: {relative.name}\n\n{text.strip()}\n"
            extracted_path = extracted_root / f"{sid}.md"
            write_text(extracted_path, normalized)
            record = {
                "source_id": sid,
                "original_path": relative.as_posix(),
                "raw_sha256": digest_bytes(raw),
                "raw_bytes": len(raw),
                "kind": kind,
                "extractor": extractor,
                "extracted_path": extracted_path.relative_to(staging).as_posix(),
                "extracted_sha256": digest_bytes((normalized.strip() + "\n").encode()),
                "extracted_characters": len(normalized.strip() + "\n"),
            }
            if attached_sidecar:
                record["transcript_sidecar"] = attached_sidecar.relative_to(input_dir).as_posix()
            if metadata:
                if kind == "pdf":
                    record["pdf_provenance"] = metadata
                else:
                    record["media_metadata"] = metadata
            if kind in {"video", "audio"}:
                duration = None
                try:
                    duration = float(metadata.get("format", {}).get("duration"))
                except (TypeError, ValueError):
                    pass
                provenance_path = attached_sidecar or (staging / ".transcription" / f"{path.stem}.vtt")
                record["transcript_provenance"] = transcript_provenance(text, provenance_path, duration)
            records.append(record)

        if not records:
            raise IntakeError("no supported Creator material could be extracted")

        capabilities = {
            name: {"available": bool(command_path(name)), "path": command_path(name)}
            for name in ("pdftotext", "ffmpeg", "ffprobe", "whisper")
        }
        write_text(staging / "creator-intent.txt", intent)
        write_json(staging / "capabilities.json", {
            "media_policy": media_policy,
            "tools": capabilities,
            "media_behavior": "Prefer an adjacent VTT/SRT transcript; otherwise transcribe locally with Whisper when available.",
        })
        write_json(staging / "intake.json", {
            "input_name": input_dir.name,
            "creator_supplied": {"directory": input_dir.name, "product_intent": intent},
            "documents": records,
            "unsupported": unsupported,
            "totals": {
                "raw_files": len(files), "extracted_documents": len(records),
                "unsupported_files": len(unsupported), "extracted_characters": sum(r["extracted_characters"] for r in records),
            },
        })
        if staging.parent == output.parent:
            staging.rename(output)
        else:
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(staging, output)
        return json.loads((output / "intake.json").read_text(encoding="utf-8"))
    finally:
        shutil.rmtree(staging.parent, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract a raw Creator course directory into a private Factory workspace")
    parser.add_argument("--input", type=Path, required=True, help="directory containing the Creator's existing materials")
    intent = parser.add_mutually_exclusive_group(required=True)
    intent.add_argument("--intent", help="one-sentence product intent")
    intent.add_argument("--intent-file", type=Path, help="UTF-8 file containing the product intent")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--media-policy", choices=("auto", "sidecar-only", "transcribe"), default="auto")
    args = parser.parse_args()
    try:
        product_intent = args.intent if args.intent is not None else args.intent_file.read_text(encoding="utf-8").strip()
        summary = intake(args.input, product_intent, args.output, args.media_policy)
        print(json.dumps(summary["totals"], sort_keys=True))
        return 0
    except (IntakeError, OSError, UnicodeError, subprocess.TimeoutExpired) as exc:
        print(f"intake error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
