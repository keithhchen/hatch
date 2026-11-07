"""Source adapters: turn an Item into a Payload (original bytes + metadata)."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence
from urllib.parse import parse_qsl, urlencode, urlparse, urlsplit

from .domain import Item, LoginRequired, Payload, Profile, UploadNotFound
from .ports import Browser, Source

_IGNORED_MANIFESTS = {"task.json", "browser-profiles.json"}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json_object(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


class UploadIndex:
    """Finds uploaded files under a read-only root.

    Match order: (1) file whose own name equals `name`; (2) sibling/manifest
    metadata (any small JSON next to or above the blobs) that mentions `name` as a
    title/name and points at a blob by path, by blob file name, or by shared stem.
    Anything else is "not found" - we never guess.
    """

    def __init__(self, root: Path):
        self.root = root
        self._files = [p for p in root.rglob("*") if p.is_file()] if root.exists() else []

    def _by_basename(self, base: str) -> list[Path]:
        return [p for p in self._files if p.name == base]

    @staticmethod
    def _strings(node: Any) -> Iterator[dict]:
        if isinstance(node, dict):
            yield node
            for v in node.values():
                yield from UploadIndex._strings(v)
        elif isinstance(node, list):
            for v in node:
                yield from UploadIndex._strings(v)

    def _from_metadata(self, name: str) -> set[Path]:
        found: set[Path] = set()
        for meta in (p for p in self._files if p.suffix == ".json" and p.name not in _IGNORED_MANIFESTS):
            try:
                data = json.loads(meta.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            for d in self._strings(data):
                values = [v for v in d.values() if isinstance(v, str)]
                if name not in values:
                    continue
                if meta.stem != name:  # sibling metadata `<blob>.json` describing `<blob>`
                    found.update(p for p in self._by_basename(meta.stem) if p.parent == meta.parent)
                for v in values:
                    if v == name:
                        continue
                    for cand in (Path(v), self.root / v, meta.parent / v):
                        if cand.is_file() and cand != meta:
                            found.add(cand)
                    found.update(self._by_basename(Path(v).name))
        return {p for p in found if p.suffix != ".json" or p.name == name}

    def by_digest(self, sha256: str) -> Path:
        """Content-addressed lookup: the provider may rename uploads, but never changes their bytes."""
        hits = [p for p in self._files if _sha256(p) == sha256.lower()]
        if len(hits) == 1:
            return hits[0]
        raise UploadNotFound(f"upload not found: sha256 {sha256}" if not hits
                             else f"upload ambiguous: sha256 {sha256} matches {len(hits)} files")

    def by_shape(self, key: str) -> Path | None:
        """The one uploaded JSON object with top-level `key` (our manifests are recognised by shape, not name)."""
        hits = [p for p in self._files if p.suffix == ".json" and key in (_json_object(p) or {})]
        return hits[0] if len(hits) == 1 else None

    def find(self, name: str) -> Path:
        direct = self._by_basename(name)
        if len(direct) == 1:
            return direct[0]
        candidates = set(direct) or self._from_metadata(name)
        if len(candidates) == 1:
            return next(iter(candidates))
        raise UploadNotFound(f"upload not found: {name}" if not candidates
                             else f"upload ambiguous: {name} matches {len(candidates)} files")


class FileSource:
    def __init__(self, uploads: UploadIndex):
        self.uploads = uploads

    def supports(self, item: Item) -> bool:
        return item.kind == "file"

    def fetch(self, item: Item, workdir: Path) -> Payload:
        name = item.upload_name or item.name or ""
        blob = self.uploads.by_digest(item.sha256) if item.sha256 else self.uploads.find(name)
        shown = item.name or name
        ext = Path(shown).suffix.lower() or blob.suffix.lower()
        workdir.mkdir(parents=True, exist_ok=True)
        link = workdir / f"source{ext}"  # blobs have no extension; tools sniff by it
        link.unlink(missing_ok=True)
        try:
            os.symlink(blob, link)
        except OSError:
            shutil.copy2(blob, link)
        return Payload(item=item, path=link, ext=ext, title=Path(shown).stem, source_name=shown)


class LinkSource:
    def __init__(self, browser: Browser, profiles: Sequence[Profile] = ()):
        self.browser, self.profiles = browser, profiles

    def supports(self, item: Item) -> bool:
        return item.kind == "link"

    def fetch(self, item: Item, workdir: Path) -> Payload:
        assert item.url
        profile = next((p for p in self.profiles if p.matches(item.url)), None)
        workdir.mkdir(parents=True, exist_ok=True)
        cap = self.browser.capture(item.url, profile, workdir)
        pid = profile.id if profile else None
        if cap.login_wall:
            raise LoginRequired(item.url, pid)
        path = cap.media or cap.pdf
        if path is None:
            path = workdir / "page.html"
            path.write_text(cap.html, "utf-8")
        return Payload(item=item, path=path, ext=path.suffix.lower(), title=cap.title,
                       author=cap.author, published_at=cap.published_at,
                       source_url=cap.final_url or item.url, html=cap.html, profile_id=pid)


class SourceRegistry:
    def __init__(self, sources: Sequence[Source]):
        self.sources = list(sources)

    def register(self, source: Source) -> "SourceRegistry":
        self.sources.append(source)
        return self

    def fetch(self, item: Item, workdir: Path) -> Payload:
        for s in self.sources:
            if s.supports(item):
                return s.fetch(item, workdir)
        raise ValueError(f"no source for kind {item.kind!r}")


# -- per-platform media discovery: pure strategies, no browser. A new platform = one HostStrategy subclass.

@dataclass(frozen=True)
class MediaCandidate:
    url: str
    content_type: str = ""
    length: int = 0


@dataclass(frozen=True)
class MediaPlan:
    """Ordered download candidates per track, best first. Empty means "could not bind to this post"."""
    videos: tuple[str, ...] = ()
    audios: tuple[str, ...] = ()


def embedded_state(html: str, var: str) -> Any:
    """JSON assigned to a page global, e.g. `window.__INITIAL_STATE__ = {...}`; None when absent/invalid."""
    m = re.search(rf"{re.escape(var)}\s*=\s*", html)
    if not m:
        return None
    try:
        return json.JSONDecoder().raw_decode(html, m.end())[0]
    except ValueError:
        return None


def urls_in(node: Any) -> Iterator[str]:
    if isinstance(node, str):
        if node.startswith("http"):
            yield node
    elif isinstance(node, dict):
        for v in node.values():
            yield from urls_in(v)
    elif isinstance(node, list):
        for v in node:
            yield from urls_in(v)


class HostStrategy:
    """Generic strategy and base class. Subclasses override class attributes only.

    signals: URL substrings that mark real media even when the content-type is generic.
    audio_signals: URL substrings that mark a separate audio track.
    strict: the page preloads neighbours; with no id match and several distinct objects, bind nothing.
    merge: video and audio arrive as separate tracks and must be muxed (ffmpeg).
    state_vars: page globals whose JSON may hold media URLs.
    """
    hosts: tuple[str, ...] = ()
    signals: tuple[str, ...] = ()
    audio_signals: tuple[str, ...] = ()
    range_params: tuple[str, ...] = ("bytestart", "byteend")
    state_vars: tuple[str, ...] = ()
    post_id_re: str | None = None
    referer: str | None = None
    strict = False
    merge = False

    def matches(self, host: str) -> bool:
        return any(host == h or host.endswith("." + h) for h in self.hosts)

    def clean(self, url: str) -> str:
        """Drop only the observed range params so the full signed object is requested."""
        parts = urlsplit(url)
        keep = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k not in self.range_params]
        return parts._replace(query=urlencode(keep)).geturl()

    def state_candidates(self, html: str) -> list[MediaCandidate]:
        urls = (u for var in self.state_vars for u in urls_in(embedded_state(html, var)))
        return [MediaCandidate(u) for u in urls if any(s in u for s in self.signals + self.audio_signals)]

    def _kind(self, c: MediaCandidate) -> str | None:
        major = c.content_type.split("/")[0].strip().lower()
        if major not in ("video", "audio") and not any(s in c.url for s in self.signals + self.audio_signals):
            return None
        return "audio" if major == "audio" or any(s in c.url for s in self.audio_signals) else "video"

    def _bind(self, urls: list[str], post_id: str | None) -> list[str]:
        bound = [u for u in urls if post_id and post_id in u]
        if bound or not self.strict or len(urls) <= 1:
            return bound or urls
        return []

    def plan(self, candidates: Iterable[MediaCandidate], page_url: str) -> MediaPlan:
        m = re.search(self.post_id_re, page_url) if self.post_id_re else None
        best: dict[str, tuple[str, MediaCandidate]] = {}
        for c in candidates:
            kind = self._kind(c)
            if kind and c.url.startswith("http"):
                url = self.clean(c.url)
                if url not in best or c.length > best[url][1].length:
                    best[url] = (kind, MediaCandidate(url, c.content_type, c.length))

        def track(kind: str) -> tuple[str, ...]:
            ranked = sorted((c for k, c in best.values() if k == kind), key=lambda c: -c.length)  # stable
            return tuple(self._bind([c.url for c in ranked], m.group(1) if m else None))

        return MediaPlan(track("video"), track("audio"))


class DouyinStrategy(HostStrategy):
    hosts = ("douyin.com", "iesdouyin.com")
    signals = ("douyinvod", "media-video", "mime_type=video_mp4")
    audio_signals = ("media-audio",)
    referer = "https://www.douyin.com/"
    merge = True


class InstagramStrategy(HostStrategy):
    hosts = ("instagram.com",)
    post_id_re = r"/(?:reels?|p|tv)/([\w-]+)"
    referer = "https://www.instagram.com/"
    strict = True
    merge = True


class XiaohongshuStrategy(HostStrategy):
    hosts = ("xiaohongshu.com", "xhslink.com")
    referer = "https://www.xiaohongshu.com/"
    merge = True


class StrategyRegistry:
    def __init__(self, strategies: Sequence[HostStrategy] = (), fallback: HostStrategy | None = None):
        self.strategies, self.fallback = list(strategies), fallback or HostStrategy()

    def register(self, strategy: HostStrategy) -> "StrategyRegistry":
        self.strategies.append(strategy)
        return self

    def for_url(self, url: str) -> HostStrategy:
        host = (urlparse(url).hostname or "").lower()
        return next((s for s in self.strategies if s.matches(host)), self.fallback)


def default_strategies() -> StrategyRegistry:
    return StrategyRegistry([DouyinStrategy(), InstagramStrategy(), XiaohongshuStrategy()])
