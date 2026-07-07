from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Iterable

from .types import DetectedSpan


_EMAIL_RE = re.compile(
    r"(?<![\w.+-])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63})(?![\w-])"
)
_URL_RE = re.compile(r"\bhttps?://[^\s<>'\")]+", re.IGNORECASE)
_PHONE_RE = re.compile(
    r"(?<!\w)(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}(?!\w)"
)
_SECRET_ASSIGNMENT_RE = re.compile(
    r"""
    \b(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer|client[_-]?secret|password|secret|token)
    \b\s*[:=]\s*['"]?
    (?P<value>[A-Za-z0-9][A-Za-z0-9._~+/=_-]{7,})
    ['"]?
    """,
    re.IGNORECASE | re.VERBOSE,
)
_SECRET_PREFIX_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:sk|pk|ghp|gho|xoxb|xoxp|hatch_test)_[A-Za-z0-9_=-]{16,}(?![A-Za-z0-9])"
)
_HIGH_ENTROPY_RE = re.compile(r"(?<![A-Za-z0-9])([A-Za-z0-9+/=_-]{32,})(?![A-Za-z0-9])")
_ACCOUNT_RE = re.compile(
    r"\b(?:account|acct|routing|card)\s*(?:number|no\.?|\#)?\s*[:=]?\s*(?P<value>\d[\d -]{7,}\d)\b",
    re.IGNORECASE | re.VERBOSE,
)
_PERSON_CONTEXT_RE = re.compile(
    r"\b(?i:ask|by|call|contact|customer|employee|for|from|manager|owner|person|with)\s+"
    r"(?P<person>[A-Z][a-z]{1,31}(?:\s+[A-Z][a-z]{1,31}){1,2})\b"
)
_PERSON_RE = re.compile(r"\b([A-Z][a-z]{1,31}(?:\s+[A-Z][a-z]{1,31}){1,2})\b")
_PERSON_STOPWORDS = frozenset(
    {
        "Access",
        "Account",
        "Api",
        "Auth",
        "Bearer",
        "Card",
        "Client",
        "Company",
        "Contact",
        "Email",
        "Example",
        "Hatch",
        "Http",
        "Https",
        "Key",
        "May",
        "Openai",
        "Password",
        "Phone",
        "Project",
        "Routing",
        "Secret",
        "Team",
        "Token",
        "Url",
    }
)


def detect_deterministic(text: str) -> tuple[DetectedSpan, ...]:
    """Detect obvious PII and secret spans without model dependencies."""

    spans: list[DetectedSpan] = []
    spans.extend(_detect_secret_assignments(text))
    spans.extend(_detect_regex(text, _SECRET_PREFIX_RE, "SECRET"))
    spans.extend(_detect_high_entropy(text))
    spans.extend(_detect_regex(text, _EMAIL_RE, "EMAIL"))
    spans.extend(_detect_urls(text))
    spans.extend(_detect_regex(text, _PHONE_RE, "PHONE"))
    spans.extend(_detect_group(text, _ACCOUNT_RE, "ACCOUNT", "value"))
    spans.extend(_detect_people(text))
    return tuple(sorted(spans, key=lambda span: (span.start, span.end, span.kind)))


def _detect_secret_assignments(text: str) -> Iterable[DetectedSpan]:
    for match in _SECRET_ASSIGNMENT_RE.finditer(text):
        yield DetectedSpan(
            start=match.start("value"),
            end=match.end("value"),
            kind="SECRET",
            source="deterministic:secret-assignment",
        )


def _detect_regex(text: str, pattern: re.Pattern[str], kind: str) -> Iterable[DetectedSpan]:
    for match in pattern.finditer(text):
        yield DetectedSpan(
            start=match.start(1) if match.lastindex else match.start(),
            end=match.end(1) if match.lastindex else match.end(),
            kind=kind,
            source=f"deterministic:{kind.lower()}",
        )


def _detect_group(text: str, pattern: re.Pattern[str], kind: str, group: str) -> Iterable[DetectedSpan]:
    for match in pattern.finditer(text):
        yield DetectedSpan(
            start=match.start(group),
            end=match.end(group),
            kind=kind,
            source=f"deterministic:{kind.lower()}",
        )


def _detect_urls(text: str) -> Iterable[DetectedSpan]:
    for match in _URL_RE.finditer(text):
        start = match.start()
        end = match.end()
        while end > start and text[end - 1] in ".,;:":
            end -= 1
        yield DetectedSpan(start=start, end=end, kind="URL", source="deterministic:url")


def _detect_people(text: str) -> Iterable[DetectedSpan]:
    emitted: list[tuple[int, int]] = []
    for match in _PERSON_CONTEXT_RE.finditer(text):
        start = match.start("person")
        end = match.end("person")
        value = text[start:end]
        if _is_person_candidate(value):
            emitted.append((start, end))
            yield DetectedSpan(
                start=start,
                end=end,
                kind="PERSON",
                source="deterministic:person-name",
                confidence=0.8,
            )

    for match in _PERSON_RE.finditer(text):
        value = match.group(1)
        if any(_ranges_overlap((match.start(1), match.end(1)), existing) for existing in emitted):
            continue
        if not _is_person_candidate(value):
            continue
        yield DetectedSpan(
            start=match.start(1),
            end=match.end(1),
            kind="PERSON",
            source="deterministic:person-name",
            confidence=0.75,
        )


def _is_person_candidate(value: str) -> bool:
    first = value.split(" ", 1)[0]
    if first in _PERSON_STOPWORDS:
        return False
    return "@" not in value and "://" not in value


def _ranges_overlap(left: tuple[int, int], right: tuple[int, int]) -> bool:
    return left[0] < right[1] and right[0] < left[1]


def _detect_high_entropy(text: str) -> Iterable[DetectedSpan]:
    for match in _HIGH_ENTROPY_RE.finditer(text):
        value = match.group(1)
        if _looks_like_secret(value):
            yield DetectedSpan(
                start=match.start(1),
                end=match.end(1),
                kind="SECRET",
                source="deterministic:entropy",
                confidence=0.7,
            )


def _looks_like_secret(value: str) -> bool:
    if len(value) < 32:
        return False

    classes = sum(
        [
            any(char.islower() for char in value),
            any(char.isupper() for char in value),
            any(char.isdigit() for char in value),
            any(char in "_-+/=" for char in value),
        ]
    )
    if classes < 3:
        return False

    return _shannon_entropy(value) >= 4.0


def _shannon_entropy(value: str) -> float:
    counts = Counter(value)
    total = len(value)
    return -sum((count / total) * math.log2(count / total) for count in counts.values())
