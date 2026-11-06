"""Thin subprocess adapter so converters never touch subprocess directly."""
from __future__ import annotations

import subprocess
from typing import Iterator, Sequence

from .domain import ToolError


class Shell:
    def __init__(self, timeout: int = 1800):
        self.timeout = timeout

    def run(self, argv: Sequence[str], timeout: int | None = None) -> str:
        try:
            p = subprocess.run(list(argv), capture_output=True, text=True, errors="replace",
                               timeout=timeout or self.timeout)
        except FileNotFoundError:
            raise ToolError(f"{argv[0]} is not installed") from None
        except subprocess.TimeoutExpired:
            raise ToolError(f"{argv[0]} timed out") from None
        if p.returncode != 0:
            raise ToolError(f"{argv[0]} exit {p.returncode}: {p.stderr.strip()[-300:]}")
        return p.stdout

    def stream(self, argv: Sequence[str], chunk: int = 65536) -> Iterator[bytes]:
        try:
            proc = subprocess.Popen(list(argv), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        except FileNotFoundError:
            raise ToolError(f"{argv[0]} is not installed") from None
        try:
            while data := proc.stdout.read(chunk):
                yield data
        finally:
            proc.stdout.close()
            if proc.poll() is None:
                proc.kill()
            rc = proc.wait()
        if rc not in (0, -9):
            raise ToolError(f"{argv[0]} exit {rc}")
