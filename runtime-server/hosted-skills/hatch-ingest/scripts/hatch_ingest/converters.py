"""Converter port implementations + registry.

A new format = one new BaseConverter subclass registered in `default_registry`.
"""
from __future__ import annotations

import dataclasses
import re
import zipfile
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence
from urllib.parse import urlparse

from .domain import ArchiveRefused, Converted, Payload, ToolError
from .ports import Converter, Transcriber
from .shell import Shell


# ---------------------------------------------------------------- context
class HtmlExtractor:
    """HTML -> Markdown of the main content. bs4/markdownify imported lazily."""
    GENERIC = ("article", "main", "[role=main]", "#content", ".content")
    # Starting points only; see references/platforms.md
    HOST_HINTS = {"mp.weixin.qq.com": "#js_content", "zhuanlan.zhihu.com": ".Post-RichText",
                  "www.xiaohongshu.com": "#detail-desc"}

    def __init__(self, hints: dict[str, str] | None = None):
        self.hints = self.HOST_HINTS if hints is None else hints

    def selector_for(self, url: str | None) -> str | None:
        return self.hints.get((urlparse(url or "").hostname or "").lower())

    def to_markdown(self, html: str, url: str | None = None) -> str:
        from bs4 import BeautifulSoup
        from markdownify import markdownify
        soup = BeautifulSoup(html, "html.parser")
        for t in soup(["script", "style", "noscript", "svg", "iframe"]):
            t.decompose()
        root = None
        for sel in filter(None, (self.selector_for(url), *self.GENERIC)):
            node = soup.select_one(sel)
            if node and len(node.get_text(strip=True)) > 200:
                root = node
                break
        md = markdownify(str(root or soup.body or soup), heading_style="ATX")
        return re.sub(r"\n{3,}", "\n\n", md).strip()


@dataclass
class ConversionContext:
    workdir: Path
    shell: Shell
    extractor: HtmlExtractor
    transcriber: Transcriber
    ocr_langs: str = "chi_sim+eng"


# ---------------------------------------------------------------- strategy helpers
Strategy = Callable[[Path, ConversionContext], str]


def cli_strategy(name: str, build_argv: Callable[[Path, ConversionContext], list[str]]) -> Strategy:
    """Wrap a CLI that prints text on stdout as a named strategy."""
    def strategy(path: Path, ctx: ConversionContext) -> str:
        return ctx.shell.run(build_argv(path, ctx))
    strategy.__name__ = name
    return strategy


def first_success(*strategies: Strategy, min_chars: int = 1) -> Callable[[Path, ConversionContext], tuple[str, str]]:
    """Try strategies in order; return (text, strategy_name) of the first with enough text."""
    def run(path: Path, ctx: ConversionContext) -> tuple[str, str]:
        errors: list[str] = []
        for s in strategies:
            try:
                text = s(path, ctx)
            except Exception as e:  # noqa: BLE001
                errors.append(f"{s.__name__}: {e}")
                continue
            if len(text.strip()) >= min_chars:
                return text.strip(), s.__name__
            errors.append(f"{s.__name__}: no text")
        raise ToolError("; ".join(errors))
    return run


markitdown = cli_strategy("markitdown", lambda p, c: ["markitdown", str(p)])
pandoc = cli_strategy("pandoc", lambda p, c: ["pandoc", str(p), "-t", "gfm", "--wrap=none"])
pdftotext = cli_strategy("pdftotext", lambda p, c: ["pdftotext", "-layout", "-enc", "UTF-8", str(p), "-"])
tesseract = cli_strategy("tesseract", lambda p, c: ["tesseract", str(p), "stdout", "-l", c.ocr_langs])

_LO_TARGET = {".doc": "docx", ".rtf": "docx", ".odt": "docx", ".ppt": "pptx", ".odp": "pptx",
              ".xls": "xlsx", ".ods": "xlsx"}


def libreoffice_then_markitdown(path: Path, ctx: ConversionContext) -> str:
    target = _LO_TARGET.get(path.suffix.lower(), "pdf")
    ctx.shell.run(["soffice", "--headless", "--convert-to", target, "--outdir", str(ctx.workdir), str(path)])
    out = ctx.workdir / f"{path.stem}.{target}"
    return pdftotext(out, ctx) if target == "pdf" else markitdown(out, ctx)


def ocr_pdf(path: Path, ctx: ConversionContext) -> str:
    prefix = ctx.workdir / "ocr-page"
    ctx.shell.run(["pdftoppm", "-r", "200", "-png", str(path), str(prefix)])
    pages = sorted(ctx.workdir.glob("ocr-page*.png"))
    return "\n\n".join(tesseract(p, ctx) for p in pages)


def read_text(path: Path) -> str:
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def fence(text: str, lang: str = "") -> str:
    mark = "~~~~~" if "```" in text else "```"
    return f"{mark}{lang}\n{text.strip()}\n{mark}"


# ---------------------------------------------------------------- converters
class BaseConverter(ABC):
    name: str = "base"
    exts: frozenset[str] = frozenset()

    def matches(self, payload: Payload) -> bool:
        return payload.ext in self.exts

    @abstractmethod
    def convert(self, payload: Payload, ctx: ConversionContext) -> Converted: ...


class HtmlPageConverter(BaseConverter):
    name = "html-page"
    exts = frozenset({".html", ".htm"})

    def matches(self, p: Payload) -> bool:
        return p.is_page or p.ext in self.exts

    def convert(self, p: Payload, ctx: ConversionContext) -> Converted:
        html = p.html if p.html is not None else read_text(p.path)
        md = ctx.extractor.to_markdown(html, p.source_url)
        c = Converted(original=p.path, converter=self.name, body=md)
        if not md:
            c.status, c.notes = "partial", ["No readable text found in the page."]
        return c


class TextConverter(BaseConverter):
    name = "text"
    PLAIN = frozenset({".txt", ".md", ".markdown"})
    exts = PLAIN | {".csv", ".tsv", ".json", ".log", ".srt", ".vtt", ".rst", ".yaml", ".yml", ".xml"}

    def convert(self, p: Payload, ctx: ConversionContext) -> Converted:
        text = read_text(p.path)
        body = text if p.ext in self.PLAIN else fence(text, p.ext.lstrip("."))
        return Converted(original=p.path, converter=self.name, body=body)


class PdfConverter(BaseConverter):
    name = "pdf"
    exts = frozenset({".pdf"})
    _extract = staticmethod(first_success(pdftotext, ocr_pdf, min_chars=20))

    def convert(self, p: Payload, ctx: ConversionContext) -> Converted:
        text, used = self._extract(p.path, ctx)
        return Converted(original=p.path, converter=f"{self.name}:{used}", body=text)


class DocumentConverter(BaseConverter):
    name = "document"
    exts = frozenset({".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt", ".odp", ".ods",
                      ".rtf", ".epub"})
    _extract = staticmethod(first_success(markitdown, pandoc, libreoffice_then_markitdown))

    def convert(self, p: Payload, ctx: ConversionContext) -> Converted:
        text, used = self._extract(p.path, ctx)
        return Converted(original=p.path, converter=f"{self.name}:{used}", body=text)


class ImageConverter(BaseConverter):
    name = "image"
    exts = frozenset({".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic"})
    MAX_EDGE = 2048
    _ocr = staticmethod(first_success(tesseract))

    def _shrink(self, src: Path, ctx: ConversionContext) -> Path:
        from PIL import Image, ImageOps
        im = ImageOps.exif_transpose(Image.open(src))
        im.thumbnail((self.MAX_EDGE, self.MAX_EDGE))
        if im.mode in ("RGBA", "LA") or "transparency" in im.info:
            out = ctx.workdir / "original.png"
            im.convert("RGBA").save(out, optimize=True)
        else:
            out = ctx.workdir / "original.jpg"
            im.convert("RGB").save(out, "JPEG", quality=85)
        return out

    def convert(self, p: Payload, ctx: ConversionContext) -> Converted:
        c = Converted(original=p.path, converter=self.name)
        try:
            c.original = self._shrink(p.path, ctx)
        except Exception as e:  # noqa: BLE001 - keep untouched original
            c.status, c.notes = "partial", [f"Image kept as uploaded (re-encode failed: {e})."]
        try:
            c.body, used = self._ocr(p.path, ctx)
            c.converter = f"{self.name}:{used}"
        except ToolError as e:
            if "no text" in str(e):
                c.notes.append("No text was recognised in the image.")
            else:
                c.status = "partial"
                c.notes.append(f"OCR unavailable: {e}")
        return c


class MediaConverter(BaseConverter):
    name = "media"
    AUDIO = frozenset({".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".amr"})
    VIDEO = frozenset({".mp4", ".mov", ".mkv", ".avi", ".webm", ".flv", ".m4v", ".ts", ".wmv", ".3gp"})
    exts = AUDIO | VIDEO
    VIDEO_ARGS = ["-vf", "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
                  "-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-c:a", "aac", "-b:a", "64k",
                  "-ac", "1", "-movflags", "+faststart"]
    AUDIO_ARGS = ["-vn", "-c:a", "aac", "-b:a", "64k", "-ac", "1"]

    def _has_video(self, p: Payload, ctx: ConversionContext) -> bool:
        if p.ext in self.AUDIO:
            return False
        try:
            out = ctx.shell.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                                 "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(p.path)])
            return bool(out.strip())
        except ToolError:
            return True

    def _compress(self, p: Payload, ctx: ConversionContext, video: bool) -> Path:
        out = ctx.workdir / ("original.mp4" if video else "original.m4a")
        ctx.shell.run(["ffmpeg", "-y", "-v", "error", "-i", str(p.path),
                       *(self.VIDEO_ARGS if video else self.AUDIO_ARGS), str(out)])
        return out

    def _pcm(self, p: Payload, ctx: ConversionContext):
        return ctx.shell.stream(["ffmpeg", "-v", "error", "-i", str(p.path), "-vn", "-ac", "1",
                                 "-ar", "16000", "-f", "s16le", "-"])

    def convert(self, p: Payload, ctx: ConversionContext) -> Converted:
        video = self._has_video(p, ctx)
        c = Converted(original=p.path, converter=self.name)
        try:
            c.original = self._compress(p, ctx, video)
        except ToolError as e:
            c.status, c.notes = "partial", [f"Media kept as uploaded (compression failed: {e})."]
        transcript = ""
        if not ctx.transcriber.available:
            c.status = "partial"
            c.notes.append("Transcription was unavailable (no transcriber configured); "
                           "the compressed original is kept without a transcript.")
        else:
            try:
                transcript = ctx.transcriber.transcribe(self._pcm(p, ctx))
                c.transcription = {"provider": ctx.transcriber.provider, "model": ctx.transcriber.model}
                if not transcript:
                    c.notes.append("No speech was detected in the audio track.")
            except Exception as e:  # noqa: BLE001
                c.status = "partial"
                c.notes.append(f"Transcription failed: {e}")
        page = ctx.extractor.to_markdown(p.html, p.source_url) if p.html else ""
        sections = [("Page text", page), ("Transcript", transcript)]
        c.body = transcript if not page else "\n\n".join(f"## {h}\n\n{t}" for h, t in sections if t)
        return c


class FallbackConverter(BaseConverter):
    """Unknown format: keep the original untouched, say so, never invent text."""
    name = "passthrough"

    def matches(self, payload: Payload) -> bool:
        return True

    def convert(self, p: Payload, ctx: ConversionContext) -> Converted:
        return Converted(original=p.path, converter=self.name, status="partial",
                         error=f"no converter for '{p.ext or 'unknown'}'; original kept untouched")


class ArchiveConverter(BaseConverter):
    """A zip is unpacked safely and each entry converted by its own type, into one document: contents, then a section per entry."""
    name = "archive"
    exts = frozenset({".zip"})
    MAX_ENTRIES = 2000
    MAX_BYTES = 200 * 1024 * 1024
    MAX_RATIO = 200
    JUNK = frozenset({".ds_store", "thumbs.db"})

    def __init__(self, entries: "ConverterRegistry"):
        self.entries = entries

    @staticmethod
    def _name(info: zipfile.ZipInfo) -> str:
        name = info.filename
        if not info.flag_bits & 0x800:  # not flagged UTF-8: zipfile guessed cp437; Chinese archives are usually GBK
            try:
                name = name.encode("cp437").decode("gb18030")
            except (UnicodeEncodeError, UnicodeDecodeError):
                pass
        return name.replace("\\", "/")

    def _members(self, zf: zipfile.ZipFile, size: int) -> list[tuple[zipfile.ZipInfo, str]]:
        infos = zf.infolist()
        if len(infos) > self.MAX_ENTRIES:
            raise ArchiveRefused(f"archive has {len(infos)} entries; the limit is {self.MAX_ENTRIES}")
        total = sum(i.file_size for i in infos)
        if total > self.MAX_BYTES:
            raise ArchiveRefused(f"archive unpacks to {total} bytes; the limit is {self.MAX_BYTES}")
        if total > max(size, 1) * self.MAX_RATIO:
            raise ArchiveRefused(f"archive is compressed {total // max(size, 1)}x; the limit is {self.MAX_RATIO}x")
        members = []
        for info in infos:
            name = self._name(info)
            parts = [p for p in name.split("/") if p]
            if name.startswith("/") or re.match(r"^[A-Za-z]:", name) or ".." in parts:
                raise ArchiveRefused(f"archive entry {name!r} has an unsafe path")
            if info.is_dir() or not parts or "__MACOSX" in parts or parts[-1].lower() in self.JUNK:
                continue
            members.append((info, "/".join(parts)))
        return members

    def _extract(self, zf: zipfile.ZipFile, info: zipfile.ZipInfo, dest: Path) -> None:
        with zf.open(info) as src:
            data = src.read(info.file_size + 1)
        if len(data) > info.file_size:
            raise ArchiveRefused(f"archive entry {info.filename!r} is larger than it declares")
        dest.write_bytes(data)

    def convert(self, p: Payload, ctx: ConversionContext) -> Converted:
        try:
            zf = zipfile.ZipFile(p.path)
        except (zipfile.BadZipFile, OSError) as e:
            raise ArchiveRefused(f"archive cannot be opened: {e}") from e
        sections, listing, problems = [], [], []
        with zf:
            for n, (info, path) in enumerate(self._members(zf, p.path.stat().st_size), 1):
                work = ctx.workdir / "entries" / str(n)
                work.mkdir(parents=True, exist_ok=True)
                source = work / ("entry" + (Path(path).suffix.lower() or ".bin"))
                try:
                    if info.flag_bits & 0x1:
                        raise ToolError("the entry is encrypted")
                    self._extract(zf, info, source)
                    entry = Payload(dataclasses.replace(p.item, name=path), source, source.suffix, source_name=path)
                    done = self.entries.select(entry).convert(entry, dataclasses.replace(ctx, workdir=work))
                    reason = done.error or ("; ".join(done.notes) if done.status != "ok" else "")
                    outcome = "converted" if done.body.strip() and done.status == "ok" else reason or "no text"
                    if done.status != "ok" or done.error:
                        problems.append(f"{path}: {reason or 'not fully converted'}")
                    sections.append(f"## {path}\n\n{done.body.strip() or '(no text)'}")
                except ArchiveRefused:
                    raise
                except Exception as e:  # noqa: BLE001 - one entry failing must not lose the others
                    outcome = f"failed: {e}"
                    problems.append(f"{path}: {e}")
                    sections.append(f"## {path}\n\n(not converted: {e})")
                listing.append(f"- {path} ({outcome})")
        body = "\n\n".join(["## Contents\n\n" + ("\n".join(listing) or "(empty archive)"), *sections])
        return Converted(original=p.path, converter=self.name, body=body, status="partial" if problems else "ok",
                         notes=problems, error="; ".join(problems) or None)


class ConverterRegistry:
    """First registered converter whose `matches` is true wins; `default` is the last resort."""

    def __init__(self, converters: Sequence[Converter] = (), default: Converter | None = None):
        self._converters = list(converters)
        self.default = default or FallbackConverter()

    def register(self, converter: Converter, first: bool = False) -> "ConverterRegistry":
        self._converters.insert(0, converter) if first else self._converters.append(converter)
        return self

    def select(self, payload: Payload) -> Converter:
        return next((c for c in self._converters if c.matches(payload)), self.default)


def default_registry() -> ConverterRegistry:
    each = [HtmlPageConverter(), TextConverter(), PdfConverter(), ImageConverter(), MediaConverter(), DocumentConverter()]
    # An archive inside an archive is listed, not unpacked: its entries go to the registry that has no ArchiveConverter.
    return ConverterRegistry([*each, ArchiveConverter(ConverterRegistry(each))])
