from __future__ import annotations

import hmac
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from typing import Callable

from .types import SECRET_KIND


Clock = Callable[[], datetime]


@dataclass(frozen=True, slots=True)
class EntityRecord:
    entity_id: str
    app_id: str
    kind: str
    pseudonym: str
    canonical_hash: str
    value: str
    created_at: datetime
    last_seen_at: datetime


class EntityMapper:
    """In-memory stable pseudonym map scoped by Hatch app id.

    The MVP keeps records in process memory. Production storage should persist
    records and root secret material in encrypted local state.
    """

    def __init__(self, root_secret: bytes | str | None = None, clock: Clock | None = None) -> None:
        if isinstance(root_secret, str):
            root_secret = root_secret.encode("utf-8")

        self._root_secret = root_secret or os.urandom(32)
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._records: dict[tuple[str, str, str], EntityRecord] = {}
        self._counters: dict[tuple[str, str], int] = {}

    def resolve(self, app_id: str, kind: str, value: str) -> EntityRecord:
        kind = kind.upper()
        if kind == SECRET_KIND:
            raise ValueError("secrets must be redacted, not mapped")
        if not app_id.strip():
            raise ValueError("app_id is required")

        canonical_hash = self.canonical_hash(app_id=app_id, kind=kind, value=value)
        key = (app_id, kind, canonical_hash)
        now = self._clock()
        existing = self._records.get(key)
        if existing is not None:
            updated = EntityRecord(
                entity_id=existing.entity_id,
                app_id=existing.app_id,
                kind=existing.kind,
                pseudonym=existing.pseudonym,
                canonical_hash=existing.canonical_hash,
                value=existing.value,
                created_at=existing.created_at,
                last_seen_at=now,
            )
            self._records[key] = updated
            return updated

        next_index = self._counters.get((app_id, kind), 0)
        self._counters[(app_id, kind)] = next_index + 1
        pseudonym = f"{kind}_{_alpha_label(next_index)}"
        record = EntityRecord(
            entity_id=f"ent_{canonical_hash[:24]}",
            app_id=app_id,
            kind=kind,
            pseudonym=pseudonym,
            canonical_hash=canonical_hash,
            value=value,
            created_at=now,
            last_seen_at=now,
        )
        self._records[key] = record
        return record

    def canonical_hash(self, app_id: str, kind: str, value: str) -> str:
        app_salt = hmac.new(self._root_secret, app_id.encode("utf-8"), sha256).digest()
        normalized = canonicalize_value(kind=kind, value=value)
        payload = f"{kind.upper()}\0{normalized}".encode("utf-8")
        return hmac.new(app_salt, payload, sha256).hexdigest()

    def records(self, app_id: str | None = None, kind: str | None = None) -> tuple[EntityRecord, ...]:
        kind = kind.upper() if kind is not None else None
        records = self._records.values()
        if app_id is not None:
            records = [record for record in records if record.app_id == app_id]
        if kind is not None:
            records = [record for record in records if record.kind == kind]
        return tuple(sorted(records, key=lambda record: (record.app_id, record.kind, record.pseudonym)))


def canonicalize_value(kind: str, value: str) -> str:
    kind = kind.upper()
    compact = " ".join(value.strip().split())

    if kind in {"EMAIL", "ORG", "PERSON", "PROJECT", "URL"}:
        return compact.casefold()
    if kind in {"ACCOUNT", "PHONE"}:
        return re.sub(r"\D+", "", compact)
    return compact


def _alpha_label(index: int) -> str:
    if index < 0:
        raise ValueError("index must be non-negative")

    label = ""
    current = index
    while True:
        current, remainder = divmod(current, 26)
        label = chr(ord("A") + remainder) + label
        if current == 0:
            return label
        current -= 1
