---
name: creator-agent-factory
description: Distill ordinary Creator course files, PDFs, videos or transcripts, text, examples, and prior work plus a natural-language product intent into a clean Hatch Agent Corpus. Use when an agent must purify Creator knowhow into a system prompt, optional local Skills and references, retrieval-only knowledge, tool declarations, synthetic QA, and isolated Evals that can run on Hatch Runtime.
---

# Creator Agent Factory

Act as the semantic distiller. The Creator provides ordinary material and a
natural-language product intent—not JSON, prompts, schemas, Skills, RAG chunks,
Evals, or tool manifests. Produce the real Corpus files through the Factory
workspace. Do not return one large JSON response or substitute a script for
semantic judgment.

Read [agent-distillation-workflow.md](references/agent-distillation-workflow.md)
before writing a Corpus.

## Work from ordinary inputs

1. Start in a new private Factory workspace. Read only the Creator material,
   natural-language intent, this Skill, its workflow reference, and the Corpus
   contract.
2. Do not inspect an old Release, proof, expected answer, or prior Factory
   output. They leak answers.
3. Normalize and hash raw material without semantic decisions:

   ```bash
   python3 scripts/intake.py \
     --input <creator-material-directory> \
     --intent-file <intent.txt> \
     --output <private-intake-workspace>
   ```

4. Read the complete extracted intake. For video/audio, read the timestamped
   transcript. For PDF, preserve page locations and inspect rendered pages when
   layout changes meaning. Do not silently sample.

`intake.py` is only an extractor and has no authority to infer Creator method.
The executing agent performs all evidence, distillation, classification, QA, and
tool decisions.

## The Corpus has four distinct layers

Put every usable piece of Creator ability in the narrowest layer that makes it
reliably available at runtime. Do not use RAG as a general dumping ground.
Do not demote behavior to retrieval merely to save prompt space: if it must
directly affect behavior, it belongs in the system prompt or the relevant local
Skill/reference.

| Layer | Put here | Do not put here |
|---|---|---|
| `instructions/system.md` | Product promise and boundary, persona/voice, global values and judgment, always-on behavior, global few-shots | Long source material; a local procedure that only matters for one task |
| `skills/<id>/SKILL.md` | An optional, bounded execution unit: when to use it, inputs, outputs, steps, checks, and permitted tools | The entire product journey; generic identity or worldview |
| `skills/<id>/references/` | A framework, method, aesthetic, or local examples needed only while that Skill runs | Material that must influence all turns; large retrieval archives |
| `knowledge/` | Long-tail, queryable facts, cases, texts, or reference material that may be needed for a particular request | Behavior rules, system instructions, Skill instructions/references, canonical few-shots, raw course dumps |

Skills are optional. Omit `skills/` when the product needs no distinct reusable
execution unit. Never create a Skill merely to make the package look complete.
A Skill is not the whole delivery workflow: split only genuinely independent
local units, and keep global product behavior in `system.md`.

Synthetic QA follows the same routing rule:

- a result that should change behavior on every turn becomes a concise rule or
  few-shot in `system.md`;
- a result relevant only to one execution unit becomes a local rule or example
  in that Skill or its `references/`;
- rare supporting material belongs in `knowledge/` only when it must be found
  on demand;
- held-outs remain in `evals/` and are never Runtime context.

Do not automatically inject the Eval dataset into the runtime prompt. The
Corpus may retain synthetic QA for evaluation, but only the deliberately routed
canonical guidance affects a live Agent.

## Distill as one executing Agent

Follow the referenced workflow. Keep private evidence and audit notes while
thinking, but never publish them. In particular:

- establish one bounded product value before extracting ability; do not start by
  copying a whole person;
- derive Creator rules only from Creator evidence; distinguish their method,
  Consumer-supplied task context, and generic domain knowledge;
- preserve priorities, omissions, and the details a general model would make
  too complete or generic;
- generate synthetic direct, composed, boundary, and out-of-scope cases only
  after the method is frozen; generate held-outs afterwards;
- self-audit, then adversarially re-read for unsupported claims and leakage.

Repair the Corpus, never the source. If a claim, capability, or expected
behavior is unsupported, omit it or make the boundary explicit. Do not ask the
Creator to review intermediate prompts, Skills, or Evals.

## Tools and real working context

Separate Factory-only ingestion from published Agent capabilities. Do not
publish extraction, ordinary conversation, prose generation, or hypothetical
integrations as tools.

`hatch.web_search` and `hatch.file_search` are always Hatch-built-in tools.
They do not need a Creator credential: Registry owns the isolated retrieval
namespace behind file search. Declare local filesystem
capability only when the bounded product needs the Consumer's actual workspace
files or must save a usable artifact. For that case declare
`hatch.local.files` with `kind: "local_harness"` and
`capability: "filesystem"`; list it in the relevant Skill's
`allowed_tool_ids` when a Skill invokes it. A no-Skill Agent still declares the
tool in its manifest. A document-centred product normally reads the selected
workspace file rather than asking the Consumer to paste it into chat.

Creator HTTP/MCP tools declare only the Hatch-managed `connection_ref`, the
one permitted `operation` / `tool_name`, and an optional input schema. Never
place URLs, credentials, provider settings, or a secret in the Corpus. Do not
invent a Creator tool when a Hatch built-in or no tool is sufficient.

## Produce only the clean Agent Corpus

Write actual assets described by
[`../packages/protocol/AGENT_CORPUS.md`](../packages/protocol/AGENT_CORPUS.md):

```text
agent-corpus/
├── agent.json
├── instructions/system.md
├── skills/                         # optional
│   └── <skill-id>/
│       ├── SKILL.md
│       └── references/             # optional, local to this Skill
├── knowledge/                      # retrieval-only; may be empty
└── evals/
    ├── synthetic-qa.json
    └── held-out.json
```

`agent.json` is the manifest. It names the product contract, system entrypoint,
any Skills and their allowed tool ids, retrieval documents, tool declarations,
and separate synthetic-QA and held-out assets. It always declares
`knowledge: { documents: [] }` when no long-tail material survives purification,
so Registry can establish the Agent's isolated retrieval namespace. It does not contain the text of
the assets, a model/provider, deployment settings, a release/version,
credentials, URLs, approval policy, or RAG index IDs. Every referenced asset
has an exact sha256 returned by the Factory workspace after it is written.

Before finishing, inspect the assets as a runnable product:

- `system.md` alone gives the Agent its global behavior and product boundary;
- each Skill is a truly local execution unit and only its references are needed
  while it runs;
- `knowledge/` is clean, searchable evidence rather than rules or raw source;
- the Eval dataset stays outside live context, with held-outs isolated;
- every tool has a concrete runtime need and a real Hatch adapter/binding;
- no raw course/PDF/video/transcript, Factory trace, private evidence, user
  data, credentials, provider settings, review workflow, release, or version is
  present.

Publish only `agent-corpus/`. Keep the intake, private evidence, audit, QA
construction, and proof outside the Corpus.
