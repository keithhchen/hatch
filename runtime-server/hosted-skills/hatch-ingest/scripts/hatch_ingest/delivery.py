"""Delivery adapter: flat output dir with unique basenames (artifact store keys by basename).

  <id>.original.<ext> (links only)   <id>.content.md   result.json   profile.<profile-id>.json
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence

from .domain import (Converted, Item, ItemResult, Payload, ProfileState, aggregate,
                     content_fields, redact, render_markdown)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class OutputDelivery:
    def __init__(self, root: Path, clock: Callable[[], str] = utc_now):
        self.root, self.clock = root, clock
        root.mkdir(parents=True, exist_ok=True)

    def deliver(self, item: Item, payload: Payload, converted: Converted) -> ItemResult:
        # An uploaded file's original already sits in object storage and is copied there server-side: only links return one.
        original = None
        if item.kind == "link":
            original = f"{item.id}.original{converted.original.suffix.lower() or '.bin'}"
            shutil.copy2(converted.original, self.root / original)
        markdown = None
        if converted.body.strip() or converted.notes:
            markdown = f"{item.id}.content.md"
            fields = content_fields(payload, converted, self.clock())
            (self.root / markdown).write_text(
                render_markdown(fields, converted.notes, converted.body), "utf-8")
        partial = converted.status != "ok" or converted.error
        error = converted.error or ("; ".join(converted.notes) if partial and converted.notes else None)
        return ItemResult(item.id, "partial" if partial else "ok", original, markdown,
                          redact(error) if error else None)

    def fail(self, item: Item, error: str) -> ItemResult:
        return ItemResult(item.id, "failed", error=redact(error))

    def save_cookies(self, profile_id: str, cookies: Sequence[dict[str, Any]]) -> None:
        (self.root / f"profile.{profile_id}.json").write_text(
            json.dumps({"cookies": list(cookies)}, ensure_ascii=False, indent=2), "utf-8")

    def finish(self, results: Sequence[ItemResult], profiles: Sequence[ProfileState]) -> list[str]:
        (self.root / "result.json").write_text(
            json.dumps(aggregate(results, profiles), ensure_ascii=False, indent=2), "utf-8")
        return sorted(p.name for p in self.root.iterdir() if p.is_file())
