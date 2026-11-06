#!/usr/bin/env python3
"""Entrypoint: python3 /mnt/agents/skills/hatch-ingest/scripts/ingest.py [--only ID ...]"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hatch_ingest.app import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
