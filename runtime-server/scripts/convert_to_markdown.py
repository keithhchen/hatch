#!/usr/bin/env python3
import sys
from markitdown import MarkItDown
if len(sys.argv) != 2:
    raise SystemExit("usage: convert_to_markdown.py FILE")
sys.stdout.write(MarkItDown().convert(sys.argv[1]).text_content)
