---
name: hatch-ingest
description: Ingest anything for Hatch. Crawl links with a real browser and convert uploaded files (documents, PDFs, images, audio, video, web pages) into an original plus full Markdown, driven by task.json. Use whenever a task.json with link/file items is present.
---

# hatch-ingest

Turns each item into `original` + `content.md`. Never summarize, never invent metadata
(title, author, dates only if the source shows them), never print env var values, never log in.

## Steps

1. Find `task.json` (and `browser-profiles.json`) by name: they are uploaded like any other
   file, so search `/mnt/agents/upload/` recursively, or `/mnt/agents/`. Do not print it: file items
   carry `download_url`, a short-lived credential. The script downloads each file itself and checks
   `bytes` and `sha256`; never download or print those URLs yourself.
2. Run (use `xvfb-run -a` when any item is a link; Chromium is headed):
   `xvfb-run -a python3 /mnt/agents/skills/hatch-ingest/scripts/ingest.py`
   (files only: omit `xvfb-run`). Flags: `--only ID` (repeatable) to redo items,
   `--task PATH`, `--profiles PATH`, `--root`, `--upload`, `--output`.
3. Read `/mnt/agents/output/result.json`. For each `failed`/`partial` item decide:
   - `download failed` (HTTP error, size or sha256 mismatch): report it, do not guess another file.
   - `login required` (profile `needs_login`): do not try to log in; report it.
   - Media or text missing on a platform link (Douyin, Instagram, Xiaohongshu, X, WeChat, Zhihu,
     podcast pages): read `references/platforms.md` for that platform's route and stop rules, inspect the
     page with the library (`hatch_ingest.browser.PlaywrightBrowser`, `hatch_ingest.sources`
     strategies, `hatch_ingest.converters`), fix the media URL for that item, re-run with `--only ID`.
     Podcast/Apple/Spotify/Xiaoyuzhou links: resolve to the publisher's RSS feed and take the episode's
     `<enclosure>` audio; do not scrape the platform page.
   - Missing tool/format: retry with another approach; otherwise leave it and report.
4. `save_artifact` every file in `/mnt/agents/output/` (the script prints them as `SAVE <name>`).
   Output is flat; names are unique because artifacts are keyed by basename:
   - `<id>.original.<ext>` - re-encoded media (mp4 H.264 720p / m4a AAC 64k mono), images
     (JPEG q85, longest edge 2048, PNG kept if alpha), documents untouched, links: main media
     or page PDF or HTML snapshot
   - `<id>.content.md` - YAML frontmatter + full text / transcript
   - `result.json` - per-item status and per-profile `ready`/`needs_login`
   - `profile.<profile-id>.json` - `{ "cookies": [...] }` refreshed cookies, only for profiles
     used; vault placeholders are never written
5. Finish with one paragraph: what succeeded, what is partial/failed and why, which profiles
   need login.

## Notes

- Transcription needs `DASHSCOPE_API_KEY`; without it media keeps its compressed original and
  the Markdown says transcription was unavailable.
- To support a new format or platform: add one class in `scripts/hatch_ingest/converters.py`
  (`matches` + `convert`) and register it in `default_registry`, or a new `Source` in
  `sources.py`. A new platform's media discovery is one `HostStrategy` subclass in `sources.py`,
  registered in `default_strategies()`. Nothing else changes.
- A `.zip` is unpacked by `ArchiveConverter` (limits: 2000 entries, 200 MB unpacked, ratio 200, no absolute or `..` paths; `__MACOSX` and `.DS_Store` skipped) into one `content.md`: a Contents list, then a section per entry converted by its own type. An unreadable or unsafe archive fails the item; entries that cannot be converted make it `partial`. A zip inside a zip is listed, not unpacked.
- Schemas: `references/task.schema.json`, `browser-profiles.schema.json`, `result.schema.json`.
- Headed Chromium cannot print `page.pdf()`; link pages without media fall back to an HTML
  snapshot as the original.
