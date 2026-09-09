# Desktop 0.1.31 — real DOCX creation and continued-edit failure

## Scope

Real authenticated Hatch Desktop conversation `conv_19f391161d9447dda2c9486cad4f4394`, local ad-hoc macOS ARM app, production Runtime. This is not Windows evidence or release completion.

## Creation: verified

Run `run_bb94e27c14364feb8db3e4fe70c76843` loaded the documents Skill, executed the bundled Node creation script, then rendered through bundled LibreOffice and Poppler. Runtime events 3853/3855 record `file_read` returning the rendered page as image content.

- DOCX: `/Users/keithchen/Documents/output/documents/hatch-uat-0131-c.docx`, 7,842 bytes.
- Original SHA-256: `2c4593e1a07f70ef3e43df6daa94c5f605517243f81da93a54fe2d9e96d1caa1`.
- Preview: `/Users/keithchen/Documents/tmp/docx-render-0131-c/page-1.png`, 47,858 bytes, 1241 × 1754.
- Direct OOXML inspection found four real text paragraphs and a Title paragraph style. Direct visual inspection found readable Chinese, without clipping or overlapping text.

This proves this simple document's creation and rendering, not general Office compatibility.

## Continued edit: failed, not accepted

The next request asked to preserve the original, append `验收状态：已复核`, save as v2, render, and inspect. Run `run_7bb9c2d109064702bdd4c3180527c697` failed before editing:

- Event 3872: `file_read` of `skill://documents/scripts/edit_docx.py` failed with `Skill is not activated: documents`.
- Event 3874/UI replaced the resource error with unavailable-tool / `Unknown Pi tool: file_read`.
- No v2 was verified.

The model retained the prior Skill instructions, but Runtime initialized per-run activation to an empty array. Resource access incorrectly depended on that transient state. Separately, event classification treated routing errors as unknown tools; the tool adapter also wrapped exceptions in successful return values instead of using Pi's native error handling.

Acceptance remains open: deploy the corrected Runtime through normal CD, repeat the edit in this conversation, verify original hash unchanged, inspect v2 content and style, and render/view the resulting page through the real tool path. Automated regression tests alone do not close this UAT gate.

## Runtime correction under validation

- Resource authority is the enabled session catalog, not transient activation. No Skill instruction reload or history mutation is introduced.
- Bare relative paths always refer to the workspace. Skill resources require an explicit URI, authorized absolute path, or catalog alias; their meaning no longer changes with activation.
- Pi owns exception-to-tool-error conversion. Registered-tool failures retain their actual text and `tool_is_error`, and the model can recover. Truly unregistered tools terminate without execution.
- Directory listing uses `lstat` for child entries, avoiding external-target metadata reads and failures on dangling links.
- Dedicated resource/Pi/runtime regression suite: 63 passed, zero skipped. Separate directory-link regression: one passed. These are automated tests, not live DOCX edit acceptance.

The existing candidate-executor test expected a second model request after an unregistered tool. It now asserts terminal rejection, zero forbidden-tool execution, and exactly one provider request. The prohibition itself was not weakened.

Full local Runtime suite after correction: 505 tests, 496 passed, zero failed, nine skipped. Log: `/tmp/hatch-runtime-final-20260909.log`. PostgreSQL-dependent skipped checks still require CI's database service; live DOCX edit remains open.

## Post-deployment real edit: passed for this document

Application CD `34340936265` completed successfully. Production Runtime was independently inspected as image `e35fe28d6dab74bb17a0e2e2fc38429e5416ce65`, healthy.

In the same existing conversation, run `run_60716cd21d454686963566ed9ea9dd91` created v2, using the bundled Python document tooling and LibreOffice/Poppler rendering. File-read events 3922/3924 read the new page; canonical tool message 3925 contains both text and image blocks.

- Original v1 SHA-256 remains `2c4593e1a07f70ef3e43df6daa94c5f605517243f81da93a54fe2d9e96d1caa1`.
- v2 path: `/Users/keithchen/Documents/output/documents/hatch-uat-0131-c-v2.docx`.
- v2 SHA-256: `b5338af808580c728aa9379ea895bc2a87fecdb75b8add078c13fa2f9163eafc`.
- Direct OOXML inspection confirms the four original paragraphs, Title style and section layout, plus the appended `验收状态：已复核` paragraph.
- Direct inspection of the single rendered page confirms readable Chinese, retained title/body layout, and no clipping or overlap.

The model voluntarily called Skill again in this run. Therefore this successful edit alone does not establish the no-reactivation case; a separate explicit read-only next-turn resource test is required. The Desktop used here still predates the pending native Poppler rebuild, so this is not evidence for that packaging change or for Windows.

## No-reactivation next-turn resource read: passed

Run `run_9d99aa16852a4c1bb3cce341b8ccfdcb` in the same conversation was explicitly asked to read `skill://documents/scripts/edit_docx.py` without calling Skill again or modifying files. Production records 3932/3934 show the requested/completed `file_read`. The complete run event list contains no Skill call or activation event, and the model then summarized the script's command arguments. This closes the specific real cross-turn resource-access regression independently of the preceding successful edit.
