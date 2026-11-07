"""Higher-order helpers for cross-cutting behaviour: retry, timing, never-fail."""
from __future__ import annotations

import functools
import time
from typing import Any, Callable


def retry(attempts: int = 2, delay: float = 1.0, skip: tuple[type[BaseException], ...] = (),
          sleep: Callable[[float], None] = time.sleep) -> Callable:
    """Retry on any Exception except those in `skip` (re-raised immediately)."""
    def deco(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(*a: Any, **k: Any) -> Any:
            for i in range(attempts):
                try:
                    return fn(*a, **k)
                except skip:
                    raise
                except Exception:
                    if i + 1 == attempts:
                        raise
                    sleep(delay * (i + 1))
        return wrapper
    return deco


def timed(label: str, log: Callable[[str], None]) -> Callable:
    def deco(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(*a: Any, **k: Any) -> Any:
            t0 = time.monotonic()
            try:
                return fn(*a, **k)
            finally:
                log(f"{label} took {time.monotonic() - t0:.1f}s")
        return wrapper
    return deco


def never_fail(on_error: Callable[..., Any]) -> Callable:
    """Turn any Exception into `on_error(*original_args, exc)` so a batch keeps going."""
    def deco(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(*a: Any, **k: Any) -> Any:
            try:
                return fn(*a, **k)
            except Exception as exc:  # noqa: BLE001 - this is the point
                return on_error(*a, exc)
        return wrapper
    return deco
