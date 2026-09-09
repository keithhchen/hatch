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
