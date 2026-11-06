"""Playwright Browser adapter. playwright is imported lazily so tests need not install it.

Run under `xvfb-run -a` (headed Chromium); falls back to headless when DISPLAY is unset.
Cookie values come from env placeholders; the sandbox proxy swaps them on the wire.
"""
from __future__ import annotations

import mimetypes
import os
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlparse

from .domain import PageCapture, Profile, ToolError, detect_login_wall
from .shell import Shell
from .sources import MediaCandidate, MediaPlan, StrategyRegistry, default_strategies

HIDE_WEBDRIVER = "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled", "--no-sandbox"]
_SAMESITE = {"strict": "Strict", "lax": "Lax", "none": "None"}

_PAGE_JS = """() => {
  const m = (sel) => { const e = document.querySelector(sel); return e ? (e.content || e.getAttribute('datetime') || e.textContent || '').trim() : null; };
  const media = document.querySelector('video[src],video source[src],audio[src],audio source[src]');
  return {
    title: m('meta[property="og:title"]') || document.title || null,
    author: m('meta[name="author"]') || m('meta[property="article:author"]') || m('[itemprop="author"]'),
    published: m('meta[property="article:published_time"]') || m('[itemprop="datePublished"]') || m('time[datetime]'),
    text: document.body ? document.body.innerText : '',
    mediaSrc: (media && (media.currentSrc || media.src)) || m('meta[property="og:video"]') || m('meta[property="og:video:url"]') || m('meta[property="og:audio"]'),
  };
}"""


def media_ext(url: str, content_type: str) -> str:
    ext = mimetypes.guess_extension(content_type.split(";")[0].strip()) if content_type else None
    ext = {".mpga": ".mp3", ".m4v": ".mp4"}.get(ext or "", ext)
    return ext or Path(urlparse(url).path).suffix.lower() or ".mp4"


def response_length(headers: Mapping[str, str]) -> int:
    """Full object size: the total in Content-Range for 206 responses, else Content-Length."""
    total = headers.get("content-range", "").rpartition("/")[2]
    raw = total if total.isdigit() else headers.get("content-length", "")
    return int(raw) if raw.isdigit() else 0


def proxy_settings(url: str) -> dict[str, str]:
    """UNTESTED: split http://user:pass@host:port into Playwright's proxy dict."""
    u = urlparse(url)
    out = {"server": f"{u.scheme}://{u.hostname}" + (f":{u.port}" if u.port else "")}
    if u.username:
        out.update(username=u.username, password=u.password or "")
    return out


class PlaywrightBrowser:
    def __init__(self, env: Mapping[str, str] = os.environ, nav_timeout_ms: int = 45000, settle_ms: int = 2500,
                 strategies: StrategyRegistry | None = None, shell: Shell | None = None):
        self.env, self.nav_timeout_ms, self.settle_ms = env, nav_timeout_ms, settle_ms
        self.strategies, self.shell = strategies or default_strategies(), shell or Shell()
        self._pw: Any = None
        self._browsers: dict[str | None, Any] = {}
        self._contexts: dict[str | None, Any] = {}

    # -- lifecycle
    def _browser(self, proxy_url: str | None) -> Any:
        if self._pw is None:
            from playwright.sync_api import sync_playwright
            self._pw = sync_playwright().start()
        if proxy_url not in self._browsers:
            opts: dict[str, Any] = {"headless": not os.environ.get("DISPLAY"), "args": LAUNCH_ARGS}
            if proxy_url:  # UNTESTED: per-profile proxy
                opts["proxy"] = proxy_settings(proxy_url)
            self._browsers[proxy_url] = self._pw.chromium.launch(**opts)
        return self._browsers[proxy_url]

    def _context(self, profile: Profile | None) -> Any:
        key = profile.id if profile else None
        if key in self._contexts:
            return self._contexts[key]
        fp = dict(profile.fingerprint) if profile else {}
        proxy_url = self.env.get(profile.proxy_env) if profile and profile.proxy_env else None
        ctx = self._browser(proxy_url).new_context(
            ignore_https_errors=True, user_agent=fp.get("userAgent"), locale=fp.get("locale"),
            timezone_id=fp.get("timezone"), viewport=fp.get("viewport") or {"width": 1366, "height": 850})
        ctx.add_init_script(HIDE_WEBDRIVER)
        if profile:
            ctx.add_cookies(self._cookies_for(profile))
        self._contexts[key] = ctx
        return ctx

    def _cookies_for(self, profile: Profile) -> list[dict[str, Any]]:
        out = []
        for c in profile.cookies:
            value = self.env.get(c.get("value_env", ""))
            if value is None:
                continue
            row: dict[str, Any] = {"name": c["name"], "value": value, "domain": c["domain"],
                                   "path": c.get("path", "/")}
            for k in ("httpOnly", "secure"):
                if k in c:
                    row[k] = c[k]
            if c.get("expires") and c["expires"] > 0:
                row["expires"] = c["expires"]
            if c.get("sameSite"):
                row["sameSite"] = _SAMESITE.get(str(c["sameSite"]).lower(), "Lax")
            out.append(row)
        return out

    # -- port
    def capture(self, url: str, profile: Profile | None, workdir: Path) -> PageCapture:
        ctx = self._context(profile)
        page = ctx.new_page()
        seen: list[MediaCandidate] = []

        def on_response(r: Any) -> None:  # every response; the host strategy decides which are media
            if r.status in (200, 206):
                seen.append(MediaCandidate(r.url, r.headers.get("content-type", ""), response_length(r.headers)))

        page.on("response", on_response)
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=self.nav_timeout_ms)
            try:
                page.wait_for_load_state("networkidle", timeout=self.settle_ms * 2)
            except Exception:  # noqa: BLE001 - busy pages never idle
                pass
            page.wait_for_timeout(self.settle_ms)
            info = page.evaluate(_PAGE_JS)
            cap = PageCapture(final_url=page.url, html=page.content(), text=info.get("text") or "",
                              title=info.get("title"), author=info.get("author"),
                              published_at=info.get("published"))
            cap.login_wall = detect_login_wall(cap.final_url, cap.text)
            if not cap.login_wall:
                strategy = self.strategies.for_url(cap.final_url)
                direct = [MediaCandidate(info["mediaSrc"], "video/")] if info.get("mediaSrc") else []
                plan = strategy.plan([*direct, *strategy.state_candidates(cap.html), *seen], cap.final_url)
                cap.media = self._acquire(ctx, plan, strategy, strategy.referer or cap.final_url, workdir)
                if cap.media is None:
                    cap.pdf = self._pdf(page, workdir)
            return cap
        finally:
            page.close()

    def _acquire(self, ctx: Any, plan: MediaPlan, strategy: Any, referer: str, workdir: Path) -> Path | None:
        """Download through the browser context (cookies apply); mux separate tracks when the host needs it."""
        tracks = strategy.merge and plan.videos and plan.audios
        video = self._download(ctx, plan.videos, referer, workdir, "video-track" if tracks else "media")
        if not tracks or video is None:
            return video or self._download(ctx, plan.audios, referer, workdir, "media")
        audio = self._download(ctx, plan.audios, referer, workdir, "audio-track")
        if audio is None:
            return video
        out = workdir / "media.mp4"
        try:
            self.shell.run(["ffmpeg", "-y", "-v", "error", "-i", str(video), "-i", str(audio),
                            "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest", str(out)])
        except ToolError:
            return video
        return out

    @staticmethod
    def _download(ctx: Any, urls: tuple[str, ...], referer: str, workdir: Path, stem: str) -> Path | None:
        for u in urls:
            try:
                resp = ctx.request.get(u, headers={"Referer": referer}, timeout=300000)  # shares cookies
                if not resp.ok:
                    continue
                out = workdir / f"{stem}{media_ext(u, resp.headers.get('content-type', ''))}"
                out.write_bytes(resp.body())
                return out
            except Exception:  # noqa: BLE001
                continue
        return None

    @staticmethod
    def _pdf(page: Any, workdir: Path) -> Path | None:
        # Chromium only prints PDFs when headless; headed (xvfb) raises -> caller snapshots HTML.
        try:
            out = workdir / "page.pdf"
            page.pdf(path=str(out), print_background=True)
            return out
        except Exception:  # noqa: BLE001
            return None

    def cookies(self) -> dict[str | None, list[dict[str, Any]]]:
        return {k: c.cookies() for k, c in self._contexts.items()}

    def close(self) -> None:
        for ctx in self._contexts.values():
            ctx.close()
        for b in self._browsers.values():
            b.close()
        if self._pw:
            self._pw.stop()
        self._contexts, self._browsers, self._pw = {}, {}, None
