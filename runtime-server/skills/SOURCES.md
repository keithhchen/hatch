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

The legal skills use the same Agent Skills `SKILL.md` format. Their workflow
may expect local playbook context such as `legal.local.md` or optional
connectors; missing context must be reported by the worker rather than
silently treated as a runtime failure.
