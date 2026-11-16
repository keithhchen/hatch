---
name: hatch-render
description: Render Hatch report HTML to PDF and a blurred preview with Chromium. Use whenever full.html and free.html are uploaded. A fixed script, no judgment.
---

# hatch-render

Turns `full.html` and `free.html` into `full.pdf`, `free.pdf` and `preview.png`.

## Steps

1. Run exactly this, with no arguments and no edits (the uploaded files are found by name under `/mnt/agents/`):
   `python3 /mnt/agents/skills/hatch-render/scripts/render.py`
2. The script prints `SAVE <name>` for each output in `/mnt/agents/output/`. `save_artifact` each of
   `full.pdf`, `free.pdf`, `preview.png` and `result.json`.
3. If the script exits non-zero, do not retry with changes and do not write the files yourself. Report its error in one sentence.
4. Finish with one sentence: the page counts from `result.json`.

Never open, summarize or modify the HTML. Never print environment variable values.
