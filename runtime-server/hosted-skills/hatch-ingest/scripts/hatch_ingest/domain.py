"""Pure domain model: items, payloads, results and the rules that act on them.

No I/O, no third-party imports. Everything here is unit-testable with plain Python.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import urlparse

VAULT_PREFIX = "__kha_vault_"
_VAULT_RE = re.compile(r"__kha_vault_[\w-]*?__")


def redact(text: str) -> str:
    """Hide vault placeholders from anything that gets logged or reported."""
    return _VAULT_RE.sub("[vault]", text)


# ---------------------------------------------------------------- errors
class IngestError(Exception):
    """Base class for expected, per-item failures."""


class LoginRequired(IngestError):
    def __init__(self, url: str, profile_id: str | None):
        super().__init__(f"login required for {url}")
        self.url, self.profile_id = url, profile_id


class DownloadFailed(IngestError):
    pass


class UploadNotFound(IngestError, FileNotFoundError):
    pass


class ToolError(IngestError):
    pass


class ArchiveRefused(IngestError):
    """The archive itself is unsafe or unreadable: the item fails, with this reason."""


class NoTranscriber(IngestError):
    pass


# ---------------------------------------------------------------- inputs
@dataclass(frozen=True)
class Item:
    id: str
    kind: str  # "link" | "file"
    url: str | None = None
    name: str | None = None
    sha256: str | None = None
    bytes: int | None = None
    download_url: str | None = None  # short-lived presigned GET; never printed

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Item":
        item_id, kind = str(d.get("id") or ""), d.get("kind")
        if not item_id or "/" in item_id or item_id.startswith("."):
            raise ValueError(f"invalid item id {item_id!r}")
        if kind == "link" and not d.get("url"):
            raise ValueError("link item needs url")
        if kind == "file" and not d.get("download_url"):
            raise ValueError("file item needs download_url")
        if kind not in ("link", "file"):
            raise ValueError(f"unknown kind {kind!r}")
        return cls(item_id, kind, d.get("url"), d.get("name"), d.get("sha256"),
                   d.get("bytes"), d.get("download_url"))


@dataclass(frozen=True)
class Profile:
    id: str
    platform: str = ""
    hosts: tuple[str, ...] = ()
    fingerprint: Mapping[str, Any] = field(default_factory=dict)
    cookies: tuple[Mapping[str, Any], ...] = ()
    proxy_env: str | None = None

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Profile":
        return cls(
            id=d["id"], platform=d.get("platform", ""),
            hosts=tuple(h.lower() for h in d.get("hosts", [])),
            fingerprint=d.get("fingerprint") or {},
            cookies=tuple(d.get("cookies") or ()),
            proxy_env=d.get("proxy_env"),
        )

    def matches(self, url: str) -> bool:
        host = (urlparse(url).hostname or "").lower()
        return any(host == h or host.endswith("." + h) for h in self.hosts)


# ---------------------------------------------------------------- pipeline data
@dataclass
class PageCapture:
    """What a browser returns for one URL."""
    final_url: str
    html: str
    text: str = ""
    title: str | None = None
    author: str | None = None
    published_at: str | None = None
    media: Path | None = None
    pdf: Path | None = None
    login_wall: bool = False


@dataclass
class Payload:
    """What a Source produces: the original bytes on disk plus known metadata."""
    item: Item
    path: Path
    ext: str  # lower-case with dot, e.g. ".pdf"
    title: str | None = None
    author: str | None = None
    published_at: str | None = None
    source_url: str | None = None
    source_name: str | None = None
    html: str | None = None  # rendered DOM for link pages
    profile_id: str | None = None

    @property
    def is_page(self) -> bool:
        return self.html is not None and self.ext in (".pdf", ".html")


@dataclass
class Converted:
    original: Path  # file to deliver as the original (possibly re-encoded)
    converter: str
    body: str = ""
    status: str = "ok"  # "ok" | "partial"
    notes: list[str] = field(default_factory=list)
    error: str | None = None
    transcription: dict[str, str] | None = None
    title: str | None = None


@dataclass
class ItemResult:
    id: str
    status: str  # ok | partial | failed
    original: str | None = None  # basename in the flat output dir
    markdown: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class ProfileState:
    id: str
    status: str  # ready | needs_login
    note: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


class ProfileLedger:
    """Tracks which profiles a run used and whether any hit a login wall."""

    def __init__(self) -> None:
        self._states: dict[str, ProfileState] = {}

    def used(self, profile_id: str | None) -> None:
        if profile_id:
            self._states.setdefault(profile_id, ProfileState(profile_id, "ready"))

    def needs_login(self, profile_id: str | None, note: str) -> None:
        if profile_id:
            self._states[profile_id] = ProfileState(profile_id, "needs_login", note)

    def states(self) -> list[ProfileState]:
        return list(self._states.values())

    def used_ids(self) -> list[str]:
        return list(self._states)


def aggregate(results: Iterable[ItemResult], profiles: Iterable[ProfileState]) -> dict[str, Any]:
    return {"items": [r.to_dict() for r in results], "profiles": [p.to_dict() for p in profiles]}


# ---------------------------------------------------------------- rules
_SIGNIN_URL = re.compile(
    r"(?<![a-z])(login|signin|sign-in|passport|sso|captcha|authwall)(?![a-z])")
_WALL_MARKERS = ("扫码登录", "请登录", "请先登录", "登录后", "登录查看", "验证码", "滑块验证",
                 "安全验证", "Sign in to", "Log in to", "Log in or sign up", "Verify you are human")


def detect_login_wall(url: str, text: str, short_text: int = 1200) -> bool:
    """Signin redirect, or a login/QR/captcha marker on a page with little real text."""
    parsed = urlparse(url)
    if _SIGNIN_URL.search((parsed.netloc + parsed.path).lower()):
        return True
    return len(text.strip()) < short_text and any(m in text for m in _WALL_MARKERS)


def _domain_in_scope(domain: str, hosts: Sequence[str]) -> bool:
    d = domain.lstrip(".").lower()
    return any(h == d or h.endswith("." + d) or d.endswith("." + h) for h in hosts)


_COOKIE_KEYS = ("name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite")


def writable_cookies(cookies: Iterable[Mapping[str, Any]], hosts: Sequence[str]) -> list[dict[str, Any]]:
    """Cookies worth writing back: in the profile's host scope, real values only
    (our vault placeholders are never persisted)."""
    out = []
    for c in cookies:
        if str(c.get("value", "")).startswith(VAULT_PREFIX):
            continue
        if hosts and not _domain_in_scope(str(c.get("domain", "")), hosts):
            continue
        row = {k: c[k] for k in _COOKIE_KEYS if k in c}
        if row.get("expires") is not None and row["expires"] <= 0:
            del row["expires"]
        out.append(row)
    return out


# ---------------------------------------------------------------- rendering
def _scalar(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False)  # JSON scalars are valid YAML


def render_frontmatter(fields: Mapping[str, Any]) -> str:
    lines = [f"{k}: {_scalar(v)}" for k, v in fields.items() if v not in (None, "")]
    return "---\n" + "\n".join(lines) + "\n---\n"


def content_fields(p: Payload, c: Converted, retrieved_at: str) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "title": p.title or c.title or p.source_name or p.source_url,
        "source_url": p.source_url,
        "source_file": p.source_name,
        "author": p.author,
        "published_at": p.published_at,
        "retrieved_at": retrieved_at,
        "kind": p.item.kind,
        "converter": c.converter,
    }
    if c.transcription:
        fields["transcription_provider"] = c.transcription.get("provider")
        fields["transcription_model"] = c.transcription.get("model")
    return fields


def render_markdown(fields: Mapping[str, Any], notes: Sequence[str], body: str) -> str:
    note_block = "".join(f"> Note: {n}\n" for n in notes)
    parts = [render_frontmatter(fields), note_block, body.strip()]
    return "\n".join(x for x in parts if x).rstrip() + "\n"
