"""Single fail-closed provider profile for Creator Agent Factory model calls."""

from __future__ import annotations

KIMI_MODEL = "kimi-k2.6"

_CONTROLS = {
    "candidate": {"thinking": {"type": "disabled"}, "temperature": 0.6, "max_completion_tokens": 3000},
    "delivery_audit": {"thinking": {"type": "disabled"}, "temperature": 0.6, "max_completion_tokens": 2500},
    "blind_judge": {"thinking": {"type": "disabled"}, "temperature": 0.6, "max_completion_tokens": 2500},
}


def controls_for(model: str, purpose: str) -> dict:
    if model != KIMI_MODEL:
        raise ValueError(f"Creator Agent Factory requires model {KIMI_MODEL}; received {model}")
    if purpose not in _CONTROLS:
        raise ValueError(f"unknown Kimi provider purpose: {purpose}")
    return dict(_CONTROLS[purpose])
