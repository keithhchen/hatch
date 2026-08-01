---
name: creator-agent-factory
description: Turn ordinary Creator course files, PDFs, videos or transcripts, text, examples, and prior work plus a natural-language product intent into a verified Hatch Agent Corpus. Use when Codex must directly distill and purify Creator knowhow, identify tool/API needs, build a grounded method and knowledge base, expand synthetic QA and isolated held-outs, compile the system prompt/Skill/RAG/Eval package, audit behavior, or publish an Agent on Hatch Runtime.
---

# Creator Agent Factory

Act as the semantic distiller. Do not delegate judgment to a distillation script
or ask the Creator for JSON, schemas, prompts, Skills, RAG chunks, Evals, or tool
manifests. The Creator supplies only ordinary source material and a
natural-language product intent; generate every technical artifact internally.

The Hatch Desktop harness separately supplies the available local workspace
capabilities: `fs.list`, `fs.read`, and `fs.write`. They are platform context,
not Creator configuration. Declare only those a product genuinely needs to
inspect the Consumer's real files or save a usable artifact there. A product
that reads an unconstrained Consumer-selected workspace needs both `fs.list`
and `fs.read`: it must discover files safely before it can inspect them. The
compiler closes this safe dependency as a final capability check.

## Work from clean inputs

1. Start in a new private Factory workspace. Read only:
   - the Creator material directory;
   - the natural-language product intent;
   - this Skill and its referenced contracts;
   - deterministic extraction, compiler, and verifier scripts.
2. Do not inspect an older Release, proof directory, evaluation output, expected
   answer, or previous Factory plan. Treat these as answer leakage.
3. Normalize and hash the raw material without semantic decisions:

   ```bash
   python3 scripts/intake.py \
     --input <creator-material-directory> \
     --intent-file <intent.txt> \
     --output <private-intake-workspace>
   ```

4. Read `creator-intent.txt`, `intake.json`, and every extracted document in the
   intake workspace. For video/audio, read the timestamped transcript; for PDF,
   preserve page locations and inspect rendered pages when layout changes meaning.
   Do not silently sample or stop after the first files.

## Distill as an Agent

Follow [agent-distillation-workflow.md](references/agent-distillation-workflow.md)
in order. Produce a private source pack that satisfies
[input-contract.md](references/input-contract.md).

The required semantic stages are:

1. Build an evidence ledger from exact Creator-authored excerpts with file,
   page, or timestamp provenance. Separate source facts from interpretation.
2. Distill the method: priorities, sequence, quality bar, deliberate omissions,
   boundaries, output contract, and the details that change decisions.
   Keep Creator method, Consumer-supplied task context, and generic domain
   knowledge separate. A label alone (for example a role title, industry, or
   goal) never supports a detailed framework of customary requirements. When
   that context would change what the Creator emphasizes, require the smallest
   concrete material that can ground it (for example a posting, brief, or
   comparable example) and return the nearest useful partial deliverable.
3. Derive rules only from cited source facts. Record the derivation; do not
   convert plausible domain knowledge into Creator authority.
4. Identify Runtime tool/API/data needs. Keep extraction tools separate from
   tools the published Agent actually needs. Do not call conversation or prose
   generation an external tool.
5. Generate grounded synthetic QA across direct, composed, boundary, and
   out-of-scope behavior. Label it synthetic; never present it as a Creator quote.
6. Generate held-outs after QA is frozen. Keep them distinct from QA and later
   candidate context.
7. Run a normal self-audit, then re-read the same artifacts in an adversarial
   pass looking for unsupported or leaked assumptions. This is still one Agent
   workflow, not a multi-Agent product architecture. Repair the private source
   pack, never the source evidence. Fail closed when a claim, rule, capability,
   or expected behavior cannot be supported.

Do not expose the Creator to the internal compiler format. Writing the evidence
ledger, manifests, claim annotations, rules, QA, and Evals is your work.

## Produce the Agent Corpus

After the semantic audit, produce the clean **Agent Corpus** described in
[`../packages/protocol/AGENT_CORPUS.md`](../packages/protocol/AGENT_CORPUS.md).
This is your finished semantic output, not a Creator form and not a Release:

```text
agent-corpus/
├── agent.json
├── instructions/system.md
├── skills/<product-skill>/SKILL.md
├── knowledge/<clean-rag-document>.md
└── evals/cases.json
```

Write `agent.json` as the manifest for exactly these assets. It carries the
product contract, instructions reference, Skills, clean RAG document references,
required Hatch and Creator tools, and Eval reference. The system instructions,
SKILL.md, RAG documents, synthetic QA and held-outs must be usable by an Agent
without consulting the Factory source pack.

Do not put raw source material, claim IDs, Factory trace, a model/provider,
deployment settings, credentials, URL, approval policy, or release/version in
the Corpus. A Creator HTTP/MCP tool may name only its Hatch-managed
`connection_ref` and allowed operation/tool. `hatch.web_search` must always be
declared. The Factory does the semantic work; Registry/Runtime merely store and
run the completed Corpus.

Inspect the compiled artifacts as products, not as a report:

- confirm `instructions/system.md` preserves priorities, sequence, omissions, and
  boundaries without Factory annotations;
- confirm the Skill defines a usable workflow rather than a course
  summary;
- confirm RAG contains useful Creator knowledge and minimum runtime provenance;
- confirm declared tools have real adapters and are not merely manifest names;
- confirm the Agent Corpus contains no raw sources, claim IDs, Factory traces,
  credentials, runtime deployment settings, or review artifacts.

## Prove behavior without leaking answers

The Runtime later installs this exact Corpus and completes a real task. When
evaluating it, run candidate and generic-baseline outputs independently on the
same input-only held-outs. Never give either candidate expected behaviors,
observable checks, forbidden answers, review notes, or old proof.

Judge decisions, ordering, omissions, boundaries, and delivered artifacts—not
verbosity or keyword recall. Corpus readiness is determined by the automatic
gates; a Creator is never a task-by-task reviewer or an Eval author.

Publish only the clean `agent-corpus/` directory; keep the intake, evidence
ledger, source pack, QA construction records, held-outs, audits, and proof
private.
