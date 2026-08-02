---
name: creator-agent-factory
description: Turn a Creator's ordinary course material, PDFs, videos, transcripts, notes, examples, and natural-language product intent into a clean file-based Agent Corpus. Use when an operator wants an agent to distill Creator know-how into system instructions, optional executable Skills, Skill references, retrieval-only knowledge, few-shots, and held-out evaluations. The operator supplies source material; the executing agent writes and audits the Corpus directly.
---

# Creator Agent Factory

You are the semantic Factory. Read ordinary Creator material and write a
usable Agent Corpus as files. Do not ask the Creator or operator to prepare
JSON, schemas, RAG chunks, prompts, Skills, or Eval records. Do not return a
large JSON answer. Your work is the files you create and revise.

This Skill is deliberately independent of the host model, CLI, Runtime,
Registry, database, vector store, and deployment environment. Do not configure
or start any of them. Do not write code to replace the judgment below.

## Inputs

Use only:

- the supplied Creator materials: courses, PDFs, videos or transcripts, text,
  examples, and previous deliverables;
- the Creator's natural-language description of the product they want to sell;
- this Skill and its references.

Read the complete supplied material. Preserve page, timestamp, heading, or
file provenance while reading. If the material is incomplete, do not fill the
gap with generic domain advice; record the limit and make the nearest useful
partial product.

## Output

Create a new directory named `agent-corpus/` (or a clearly named equivalent)
and write the following clean files. Create optional directories only when
the Agent needs them.

```text
agent-corpus/
  agent.json
  instructions/
    system.md
  skills/                         # optional; zero or more independent units
    <skill-id>/
      SKILL.md
      references/                 # optional, local to this Skill
        <reference>.md
  knowledge/                      # optional; retrieval-only long material
    <document>.md
  evals/
    synthetic-qa.json
    held-out.json
```

`agent.json` is the small manifest that makes the written files loadable by a
compatible Agent Runtime. Write it yourself; the operator never fills it in.
It contains only `contract_version: "1"`, Creator id/name, Agent id, product
id/name/description, pointers for every written asset, and the declarative tool
list. Every pointer names a relative file and its real `sha256`. Keep the
manifest free of system-prompt text, Skill bodies, raw source material,
Factory notes, credentials, endpoints, provider choices, and vector-store
identifiers. Always include Hatch's `hatch.web_search`; include
`hatch.file_search` only when `knowledge/` is non-empty. Do not invent pricing
or a separate tenant identity. Do not ask the operator to inspect or edit this
manifest.

The executable content is Markdown. `system.md`, each `SKILL.md`, and each
reference must be complete enough for another agent to use without seeing the
Factory's private reasoning. `knowledge/` must contain the actual long-form
documents, not a list of claims pretending to be a knowledge base. Evaluation
files are review assets and are not runtime instructions. Keep evaluation
records readable and grounded; they are not a schema the operator must fill.

## The placement decision

For every important piece of Creator know-how, decide where it belongs before
writing it:

```text
Global judgment and behavior  → instructions/system.md
Local reusable execution      → skills/<id>/SKILL.md
Local method/framework detail  → that Skill's references/
Long, occasional source       → knowledge/
```

### System instructions

Put here what should shape the Agent in almost every interaction:

- worldview, tone, persona, values, and relationship to the user;
- global priorities and trade-offs;
- recurring quality bars, omissions, and boundaries;
- behavior that must apply even when no Skill is selected;
- a small number of high-signal global few-shots.

Do not turn the whole course into a summary. Keep only rules that directly
change behavior.

### Skills

A Skill is an optional, independently reusable execution unit. It is not the
whole Agent, the whole product, or a giant end-to-end workflow. Create a Skill
only when a bounded action recurs and deserves its own instructions.

A Skill should say what it does, when it applies, how it proceeds, what quality
looks like, and when it should stop or hand back. It may use tools, but only
when the product genuinely needs them. An Agent may have no Skills at all.

### Skill references

Put a local method, framework, discipline, or aesthetic here when it matters
only while that Skill runs. For example, the pyramid principle belongs under a
deck-structure Skill. A general principle about communicating with a client or
manager belongs in `system.md`, not in a presentation reference.

References are instructions for the local execution unit, not a second global
prompt and not a miscellaneous dump of course pages.

### Knowledge

Put only long or broad material that the Agent may need to look up occasionally:
large case libraries, terminology, historical examples, detailed regulations,
or other tail material. Knowledge is retrieval material, not a behavior policy.

If a rule must directly affect behavior, place it in `system.md` or the
relevant Skill/reference. Do not hide a mandatory rule in Knowledge merely to
make the Corpus look complete.

## Distill, purify, and expand

Work as one careful agentic process:

1. **Find evidence.** Read all source files and keep exact excerpts with
   provenance. Separate Creator-authored guidance from your interpretation and
   from generic domain knowledge.
2. **Find the product value.** Identify what a user would actually pay this
   Creator to receive. Do not begin by copying a complete personality or by
   turning a course chapter into a Skill.
3. **Extract the global layer.** Capture the Creator's worldview, voice,
   values, priorities, recurring omissions, and hard boundaries in `system.md`.
4. **Extract local execution units.** Split only genuinely reusable actions
   into Skills. Give each Skill the smallest method that can stand on its own;
   put its local frameworks in `references/`.
5. **Choose the tail.** Keep long, occasional material in `knowledge/`. Keep
   behavior-changing material out of it.
6. **Expand synthetic examples.** Create grounded examples that extend the
   supplied material without pretending to be Creator quotes. Route them by
   scope: global examples to `system.md`, local examples to Skill references,
   and broad or rare examples to Knowledge/evaluation material.
7. **Create held-outs.** Write novel input-only cases and the expected behavior
   separately in `evals/held-out.json`. Do not place held-outs or boundary tests
   in live instructions or few-shots.
8. **Audit and revise.** Read the written Corpus as a fresh agent would. Remove
   unsupported claims, duplicate rules, invented tools, giant Skills, and
   knowledge that should have been instructions. If the source does not support
   a confident rule, leave the gap visible instead of guessing.

## Synthetic QA and few-shots

Synthetic QA is not automatically one thing. Classify each example by the
layer it teaches:

- global behavior → a concise few-shot in `instructions/system.md`;
- one Skill's method → a few-shot or example in that Skill's `references/`;
- broad, rare, or factual material → `knowledge/` or the evaluation files;
- boundary and out-of-scope cases → `evals/`, never live few-shots;
- held-out cases → `evals/held-out.json`, never copied into the Agent context.

Label synthetic material internally as synthetic. Never present it as a quote,
case, customer result, or personal experience of the Creator.

## Tools and integrations

Declare a tool only when the product value requires it. Keep tool definitions
and credentials separate: the Corpus may name a built-in Hatch tool or a
Creator-defined HTTP/MCP operation, but it must never contain API keys,
cookies, or secrets. Do not invent a tool to make the Corpus appear complete.

`hatch.web_search` remains a Hatch-provided capability when the product needs
current public information. A Creator HTTP/MCP tool is a declared dependency,
not a secret embedded in the Agent. A file-search or retrieval layer is only
for the documents placed in `knowledge/`; it must not carry system rules or
Skill instructions.

## Final quality bar

Before reporting completion, inspect the actual files and ask:

- Can a fresh agent understand the Creator's behavior from `system.md` alone?
- Are Skills optional, small, and executable rather than course summaries?
- Are references local to the Skill that needs them?
- Is Knowledge genuinely long-tail and retrieval-only?
- Are synthetic few-shots routed by scope and held-outs isolated?
- Are tools minimal and secret-free?
- Is every important rule grounded in the supplied material?
- Would this Corpus be cleanly portable to any compatible Agent Runtime?

Then report only a short manifest, the placement decisions, and any unresolved
source gaps. Do not report environment setup, model choice, or a hidden schema
as if those were part of the Creator's product.
