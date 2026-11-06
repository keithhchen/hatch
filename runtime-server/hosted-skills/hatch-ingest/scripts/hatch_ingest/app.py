"""Application service + composition root."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .browser import PlaywrightBrowser
from .converters import ConversionContext, ConverterRegistry, HtmlExtractor, default_registry
from .delivery import OutputDelivery
from .domain import (Converted, Item, ItemResult, LoginRequired, Payload, Profile, ProfileLedger,
                     redact, writable_cookies)
from .ports import Browser, Delivery, Transcriber
from .resilience import never_fail, retry, timed
from .shell import Shell
from .sources import FileSource, LinkSource, SourceRegistry, UploadIndex
from .transcribe import DashScopeHttpTranscriber, NullTranscriber


def _record_failure(self: "Ingestor", item: Item, exc: Exception) -> ItemResult:
    if isinstance(exc, LoginRequired):
        self.ledger.needs_login(exc.profile_id, f"login wall at {exc.url}")
    self.log(f"[{item.id}] failed: {type(exc).__name__}: {exc}")
    return self.delivery.fail(item, f"{type(exc).__name__}: {exc}")


class Ingestor:
    def __init__(self, sources: SourceRegistry, converters: ConverterRegistry, delivery: Delivery,
                 make_context: Callable[[Path], ConversionContext], workroot: Path,
                 ledger: ProfileLedger, log: Callable[[str], None]):
        self.sources, self.converters, self.delivery = sources, converters, delivery
        self.make_context, self.workroot, self.ledger, self.log = make_context, workroot, ledger, log

    def run(self, items: Sequence[Item]) -> list[ItemResult]:
        return [self.process(i) for i in items]

    @never_fail(_record_failure)
    def process(self, item: Item) -> ItemResult:
        workdir = self.workroot / item.id
        workdir.mkdir(parents=True, exist_ok=True)
        payload = self._fetch(item, workdir)
        self.ledger.used(payload.profile_id)
        converted = self._convert(payload, workdir)
        return self.delivery.deliver(item, payload, converted)

    @retry(attempts=2, delay=2.0, skip=(LoginRequired, FileNotFoundError))
    def _fetch(self, item: Item, workdir: Path) -> Payload:
        return self.sources.fetch(item, workdir)

    def _convert(self, payload: Payload, workdir: Path) -> Converted:
        converter = self.converters.select(payload)
        run = timed(f"[{payload.item.id}] {converter.name}", self.log)(converter.convert)
        try:
            return run(payload, self.make_context(workdir))
        except Exception as exc:  # noqa: BLE001 - keep the original, report the error
            self.log(f"[{payload.item.id}] conversion failed: {exc}")
            return Converted(original=payload.path, converter=converter.name, status="partial",
                             error=f"conversion failed: {exc}")


# ---------------------------------------------------------------- composition
def build_transcriber(env: Mapping[str, str]) -> Transcriber:
    key = env.get("DASHSCOPE_API_KEY")
    return DashScopeHttpTranscriber(key) if key else NullTranscriber()


def find_input(name: str, key: str, explicit: str | None, upload: UploadIndex, root: Path) -> Path | None:
    """task.json / browser-profiles.json: explicit path, else uploaded by name, else by shape, else under root."""
    if explicit:
        return Path(explicit)
    try:
        return upload.find(name)
    except FileNotFoundError:
        found = upload.by_shape(key)
        return found or (root / name if (root / name).is_file() else None)


def parse_items(raw: Sequence[Mapping[str, Any]]) -> tuple[list[Item], list[ItemResult]]:
    items, bad = [], []
    for d in raw:
        try:
            items.append(Item.from_dict(d))
        except (ValueError, TypeError) as e:
            bad.append(ItemResult(str(d.get("id", "unknown")), "failed", error=f"invalid item: {e}"))
    return items, bad


def main(argv: Sequence[str] | None = None, env: Mapping[str, str] = os.environ) -> int:
    ap = argparse.ArgumentParser(description="Hatch ingest: links/files -> original + Markdown")
    ap.add_argument("--root", default="/mnt/agents")
    ap.add_argument("--upload"), ap.add_argument("--output"), ap.add_argument("--work")
    ap.add_argument("--task"), ap.add_argument("--profiles")
    ap.add_argument("--only", action="append", default=[], help="process only these item ids")
    args = ap.parse_args(argv)

    root = Path(args.root)
    log = lambda m: print(redact(m), file=sys.stderr)  # noqa: E731
    upload = UploadIndex(Path(args.upload or root / "upload"))
    task_path = find_input("task.json", "items", args.task, upload, root)
    if not task_path or not task_path.is_file():
        log("task.json not found")
        return 2
    task = json.loads(task_path.read_text("utf-8"))
    prof_path = find_input("browser-profiles.json", "profiles", args.profiles, upload, root)
    profiles = ([Profile.from_dict(p) for p in json.loads(prof_path.read_text("utf-8")).get("profiles", [])]
                if prof_path and prof_path.is_file() else [])

    items, bad = parse_items(task.get("items", []))
    if args.only:
        items = [i for i in items if i.id in args.only]
    out = OutputDelivery(Path(args.output or root / "output"))
    transcriber, shell, extractor = build_transcriber(env), Shell(), HtmlExtractor()
    browser: Browser = PlaywrightBrowser(env)
    ledger = ProfileLedger()
    ingestor = Ingestor(
        SourceRegistry([LinkSource(browser, profiles), FileSource(upload)]), default_registry(), out,
        lambda wd: ConversionContext(wd, shell, extractor, transcriber),
        Path(args.work or root / "work"), ledger, log)
    try:
        results = bad + ingestor.run(items)
        write_cookie_files(browser, profiles, ledger, out, log)
    finally:
        browser.close()
    files = out.finish(results, ledger.states())
    for r in results:
        print(f"{r.id}\t{r.status}\t{r.error or ''}")
    for f in files:
        print(f"SAVE {f}")
    return 0


@never_fail(lambda browser, profiles, ledger, out, log, exc: log(f"cookie writeback failed: {exc}"))
def write_cookie_files(browser: Browser, profiles: Sequence[Profile], ledger: ProfileLedger,
                       out: Delivery, log: Callable[[str], None]) -> None:
    by_id = {p.id: p for p in profiles}
    for pid, cookies in browser.cookies().items():
        if pid in by_id and pid in ledger.used_ids():
            out.save_cookies(pid, writable_cookies(cookies, by_id[pid].hosts))
