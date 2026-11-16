---
name: hatch-render
description: Render a Hatch report's HTML to PDF, its first page, and a preview with the next pages blurred, with Chromium. Use whenever a full-<id>.html is uploaded. A fixed script, no judgment.
---

# hatch-render

Turns `full-<id>.html` into `full.pdf`, `free.pdf` (its first page) and `preview.png` (page 1, then the next pages blurred).

## Steps

1. The task names the uploaded report file (`full-<id>.html`) and an output folder (`/mnt/agents/output/<id>`). Run exactly this, with those two values and nothing else changed:
   `python3 /mnt/agents/skills/hatch-render/scripts/render.py --full full-<id>.html --output /mnt/agents/output/<id>`
   The upload folder keeps files from earlier tasks: only these names are this task's.
2. The script prints `SAVE <name>` for each output in the output folder. `save_artifact` each of
   `full.pdf`, `free.pdf`, `preview.png` and `result.json` from that folder.
3. If the script exits non-zero, do not retry with changes and do not write the files yourself. Report its error in one sentence.
4. Finish with one sentence: the page counts from `result.json`.

Never open, summarize or modify the HTML. Never print environment variable values.
