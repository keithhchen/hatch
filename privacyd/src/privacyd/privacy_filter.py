from __future__ import annotations

import importlib
from collections.abc import Iterable
from typing import Any, Protocol

from .types import DetectedSpan


class PrivacyFilterAdapter(Protocol):
    def detect(self, text: str) -> Iterable[DetectedSpan]:
        """Return model-detected sensitive spans for text."""


class NullPrivacyFilterAdapter:
    def detect(self, text: str) -> tuple[DetectedSpan, ...]:
        return ()


class OpenAIPrivacyFilterAdapter:
    """Optional boundary around the OpenAI Privacy Filter package.

    This class deliberately stays out of the default path so tests and local
    deterministic scans do not require model weights or the package install.
    """

    def __init__(self, detector: Any | None = None) -> None:
        self._detector = detector or self._load_default_detector()

    def detect(self, text: str) -> tuple[DetectedSpan, ...]:
        raw_spans = self._call_detector(text)
        return tuple(_coerce_span(item) for item in raw_spans)

    def _call_detector(self, text: str) -> Iterable[Any]:
        if hasattr(self._detector, "detect"):
            return self._detector.detect(text)
        if callable(self._detector):
            return self._detector(text)
        raise RuntimeError("OpenAI Privacy Filter detector is not callable")

    @staticmethod
    def _load_default_detector() -> Any:
        try:
            opf = importlib.import_module("opf")
        except ImportError as exc:
            raise RuntimeError(
                "OpenAI Privacy Filter is optional. Install and configure the opf package "
                "before constructing OpenAIPrivacyFilterAdapter."
            ) from exc

        if hasattr(opf, "PrivacyFilter"):
            return opf.PrivacyFilter()
        if hasattr(opf, "load"):
            return opf.load()
        raise RuntimeError("Unsupported opf package shape: expected PrivacyFilter or load()")


def _coerce_span(item: Any) -> DetectedSpan:
    if isinstance(item, DetectedSpan):
        return item

    if isinstance(item, dict):
        start = item.get("start", item.get("start_idx"))
        end = item.get("end", item.get("end_idx"))
        kind = item.get("kind", item.get("type", item.get("label", item.get("entity"))))
        confidence = item.get("confidence", item.get("score", 1.0))
    else:
        start = getattr(item, "start", getattr(item, "start_idx", None))
        end = getattr(item, "end", getattr(item, "end_idx", None))
        kind = getattr(item, "kind", getattr(item, "type", getattr(item, "label", None)))
        confidence = getattr(item, "confidence", getattr(item, "score", 1.0))

    if start is None or end is None or kind is None:
        raise ValueError(f"Cannot coerce privacy filter span: {item!r}")

    return DetectedSpan(
        start=int(start),
        end=int(end),
        kind=_normalize_kind(str(kind)),
        source="opf",
        confidence=float(confidence),
    )


def _normalize_kind(kind: str) -> str:
    normalized = kind.upper().replace("-", "_")
    if "EMAIL" in normalized:
        return "EMAIL"
    if "PHONE" in normalized:
        return "PHONE"
    if "PERSON" in normalized or "NAME" in normalized:
        return "PERSON"
    if "URL" in normalized or "URI" in normalized:
        return "URL"
    if "ADDRESS" in normalized:
        return "ADDRESS"
    if "ACCOUNT" in normalized or "CARD" in normalized:
        return "ACCOUNT"
    if any(token in normalized for token in ("KEY", "TOKEN", "SECRET", "PASSWORD")):
        return "SECRET"
    if "ORG" in normalized or "COMPANY" in normalized:
        return "ORG"
    return normalized
