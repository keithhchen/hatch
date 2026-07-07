"""Hatch privacyd local sidecar."""

from .entity_map import EntityMapper, EntityRecord
from .sanitizer import SanitizationResult, sanitize_text
from .scanner import detect_deterministic
from .types import DetectedSpan

__all__ = [
    "DetectedSpan",
    "EntityMapper",
    "EntityRecord",
    "SanitizationResult",
    "detect_deterministic",
    "sanitize_text",
]
