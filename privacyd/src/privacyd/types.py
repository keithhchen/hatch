from __future__ import annotations

from dataclasses import dataclass


SECRET_KIND = "SECRET"

ENTITY_KINDS = frozenset(
    {
        "ACCOUNT",
        "ADDRESS",
        "EMAIL",
        "FILE",
        "ORG",
        "PERSON",
        "PHONE",
        "PROJECT",
        "URL",
    }
)


@dataclass(frozen=True, slots=True)
class DetectedSpan:
    start: int
    end: int
    kind: str
    source: str
    confidence: float = 1.0

    def __post_init__(self) -> None:
        if self.start < 0:
            raise ValueError("span start must be non-negative")
        if self.end <= self.start:
            raise ValueError("span end must be greater than start")
        if not self.kind:
            raise ValueError("span kind is required")
        if not self.source:
            raise ValueError("span source is required")

        object.__setattr__(self, "kind", self.kind.upper())
