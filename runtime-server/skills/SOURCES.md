# Server Skill Sources

These skills are vendored into the server skill root. The runtime discovers
each child directory by its `SKILL.md`; it does not load this file into model
context.

## OpenAI Official Catalog

Source: https://github.com/openai/skills/tree/main/skills/.curated

- `pdf`
- `security-best-practices`
- `gh-fix-ci`

These directories retain the upstream `SKILL.md`, `agents/openai.yaml`,
licenses, and bundled references/assets/scripts.

## Legal Agent Skills

Source: https://github.com/anthropics/knowledge-work-plugins/tree/main/legal/skills

- `brief`
- `compliance-check`
- `legal-risk-assessment`
- `triage-nda`
- `review-contract`

## Hatch first-party document Skills

The four document Skills below are maintained in this repository. Their
scripts are original Hatch adapters around public Python/Node libraries and
the bundled LibreOffice/Poppler command-line tools; they are not copied from
the separately licensed OpenAI or Anthropic skill packages.

- `documents`: python-docx/lxml + docx (with package-level tracked-change acceptance)
- `pdf`: pypdf/pdfplumber/reportlab + pdf-lib
- `presentations`: python-pptx/lxml + pptxgenjs
- `spreadsheets`: openpyxl + exceljs (with LibreOffice recalculation)

The internal `_shared/libreoffice.py` helper gives every Office conversion a
unique profile, a bounded subprocess, and Windows-specific cleanup for
orphaned `soffice.bin` children. It is bundled with the four Skills but is not
itself exposed as a user-facing Skill.

`requirements.lock` pins the direct Python dependency set used when the
Desktop runtime is built. The Desktop Node toolchain has its own package-lock
and is installed from the bundled Node executable. Desktop builds also include
fixed-version LibreOffice and Poppler native engines; the generated bundle
removes only LibreOffice's interactive help/gallery/wizard/template/Java/
extension payloads, while retaining the headless Office engine, filters,
configuration, and fonts used for real read/write/conversion/rendering.
micromamba is used only at build time to resolve and copy the Poppler
environment and is not shipped.

The legal skills use the same Agent Skills `SKILL.md` format. Their workflow
may expect local playbook context such as `legal.local.md` or optional
connectors; missing context must be reported by the worker rather than
silently treated as a runtime failure.
