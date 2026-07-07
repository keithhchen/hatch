from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Callable, Iterable

from .entity_map import EntityMapper
from .privacy_filter import NullPrivacyFilterAdapter, PrivacyFilterAdapter
from .scanner import detect_deterministic
from .types import ENTITY_KINDS, SECRET_KIND, DetectedSpan


SECRET_REPLACEMENT = "<SECRET_REDACTED>"

Detector = Callable[[str], Iterable[DetectedSpan]]


@dataclass(frozen=True, slots=True)
class SanitizedFinding:
    kind: str
    start: int
    end: int
    replacement: str
    pseudonym: str | None
    redacted: bool
    source: str
    confidence: float


@dataclass(frozen=True, slots=True)
class SanitizationResult:
    app_id: str
    sanitized_text: str
    findings: tuple[SanitizedFinding, ...]


def sanitize_text(
    text: str,
    *,
    app_id: str,
    entity_mapper: EntityMapper,
    deterministic_detector: Detector = detect_deterministic,
    privacy_filter: PrivacyFilterAdapter | None = None,
) -> SanitizationResult:
    """Sanitize text for outbound creator context.

    This is the pure pipeline boundary used by tests and the FastAPI service.
    All stateful behavior is supplied through EntityMapper.
    """

    if not app_id.strip():
        raise ValueError("app_id is required")

    adapter = privacy_filter or NullPrivacyFilterAdapter()
    detected = list(deterministic_detector(text))
    detected.extend(adapter.detect(text))
    spans = merge_spans(detected, text_length=len(text))

    cursor = 0
    pieces: list[str] = []
    findings: list[SanitizedFinding] = []
    for span in spans:
        pieces.append(text[cursor : span.start])
        source_value = text[span.start : span.end]
        replacement, pseudonym, redacted = _replacement_for_span(
            app_id=app_id,
            span=span,
            source_value=source_value,
            entity_mapper=entity_mapper,
        )
        pieces.append(replacement)
        findings.append(
            SanitizedFinding(
                kind=span.kind,
                start=span.start,
                end=span.end,
                replacement=replacement,
                pseudonym=pseudonym,
                redacted=redacted,
                source=span.source,
                confidence=span.confidence,
            )
        )
        cursor = span.end

    pieces.append(text[cursor:])
    return SanitizationResult(
        app_id=app_id,
        sanitized_text="".join(pieces),
        findings=tuple(findings),
    )


def merge_spans(spans: Iterable[DetectedSpan], *, text_length: int) -> tuple[DetectedSpan, ...]:
    valid_spans = [
        span
        for span in spans
        if 0 <= span.start < span.end <= text_length and span.kind in ENTITY_KINDS | {SECRET_KIND}
    ]
    selected: list[DetectedSpan] = []
    for span in sorted(valid_spans, key=lambda candidate: (-_priority(candidate), -_length(candidate), candidate.start)):
        if any(_overlaps(span, existing) for existing in selected):
            continue
        selected.append(span)
    return tuple(sorted(selected, key=lambda candidate: candidate.start))


def _replacement_for_span(
    *,
    app_id: str,
    span: DetectedSpan,
    source_value: str,
    entity_mapper: EntityMapper,
) -> tuple[str, str | None, bool]:
    if span.kind == SECRET_KIND:
        return SECRET_REPLACEMENT, None, True

    record = entity_mapper.resolve(app_id=app_id, kind=span.kind, value=source_value)
    return record.pseudonym, record.pseudonym, False


def _priority(span: DetectedSpan) -> int:
    priorities = {
        "SECRET": 100,
        "EMAIL": 90,
        "URL": 85,
        "PHONE": 85,
        "ACCOUNT": 80,
        "ADDRESS": 70,
        "FILE": 65,
        "PERSON": 60,
        "ORG": 55,
        "PROJECT": 55,
    }
    return priorities.get(span.kind, 10)


def _length(span: DetectedSpan) -> int:
    return span.end - span.start


def _overlaps(left: DetectedSpan, right: DetectedSpan) -> bool:
    return left.start < right.end and right.start < left.end
