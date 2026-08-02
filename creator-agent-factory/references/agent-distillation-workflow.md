# Agent distillation workflow

Use this workflow while reading the complete normalized intake. It governs
semantic judgment; no Python script may replace these stages.

## 1. Establish the product boundary

Read the natural-language intent before interpreting the course. Write down:

- who pays and what usable work they receive;
- what input or context the Agent needs;
- what is explicitly out of scope;
- which external outcomes must not be guaranteed;
- whether pricing is stated or remains unset.

Do not begin with a digital twin. Begin with one bounded value proposition, then
extract only the Creator knowledge needed to deliver it.

## 2. Build the evidence ledger

Read every extracted source. Retain exact passages that change a decision,
priority, sequence, quality threshold, omission, boundary, output, or example.
For each retained item record:

- stable source-fact ID;
- neutral label and method role;
- exact excerpt copied from the extracted source;
- intake source ID and original file;
- exact page, timestamp, heading, or file location;
- priority from 1–10;
- deliberate omission text only when the source actually defines one.

Never paraphrase inside the evidence field. Keep adjacent context when a sentence
would otherwise be misleading. Do not treat repeated phrasing as independent
evidence. Record rejected candidate evidence and the rejection reason privately.

Write retained excerpts into `sources/*.md` with `<!-- claim:S-... -->` markers,
and record the same IDs in `factory-plan.json.claim_annotations`. Maintain a
human-readable `work/evidence-ledger.md` beside the compiler inputs.

## 3. Distill and purify the method

Using only the evidence ledger:

1. Order the Creator's actual phases.
2. Identify priorities and tie-breakers.
3. Identify quality bars and what “done” means.
4. Preserve details the Creator notices that a generic answer may overlook.
5. Preserve deliberate blank space: what the Creator deletes, defers, or avoids.
6. Separate hard boundaries from stylistic preferences.
7. Define when the Agent must refuse, narrow scope, or request missing context.

Treat the Creator's method, the Consumer's supplied task material, and generic
domain knowledge as separate evidence classes. Do not turn a thin task label
into a detailed customary framework. If a role, brief, market, audience, or
other external context would change the Creator's priorities, define the
smallest grounding input the Consumer must supply and the partial work that can
still proceed without it. A fluent generic explanation is neither Creator
authority nor Consumer evidence.

The compiled Agent must retain a usable missing-input path. If a Consumer has
not supplied a required material, workspace permission, tool result, or target
clarification, it should not invent a deliverable or collapse into a generic
error. It should state the bounded limit, identify the missing input, and offer
the nearest promised work that can begin once the input is present. This is a
Hatch delivery invariant, not a new claim attributed to the Creator.

Create a derived rule only when at least two distinct source facts jointly imply
an operational decision. Cite both facts and explain the inference. If the
inference is merely reasonable domain practice, omit it or label it unresolved.

Write the distilled method into `factory-plan.json.method`. Citation arrays must
contain exact source-fact or derived-rule IDs, never prose or phase IDs.

## 4. Determine tools, APIs, and data

Separate four things:

- intake/extraction utilities used only by the Factory;
- local Runtime capabilities available to the Consumer Agent;
- external APIs explicitly required by the product intent;
- proprietary datasets or unresolved integrations.

Do not turn PDF extraction, transcription, ordinary conversation, asking a
question, formatting, or writing prose into published Agent tools. Every
external tool need must match an external tool declared by the product and
supported by the intent. Mark a genuine missing integration unresolved instead
of inventing an adapter.

For Hatch Desktop, `fs.list`, `fs.read`, and `fs.write` are available inside
the Consumer-selected workspace. This is runtime context, not Creator input.
Declare `fs.read` when the product must inspect real local files and `fs.write`
when it must leave a usable artifact; add `fs.list` only when it needs to
discover files. Do not declare a capability merely because it exists.

Record private implementation needs in `factory-plan.json.tool_needs`; put only
actual deployable capabilities in `source-manifest.json.product`.

## 5. Expand synthetic QA

Freeze the method before expansion. Generate at least two distinct QA rows for
each category:

- `direct`: applies one explicit rule;
- `composed`: combines multiple supported rules;
- `boundary`: narrows or refuses while offering the nearest safe action;
- `out_of_scope`: recognizes work the product does not promise.

Each answer must cite source-fact or derived-rule IDs. Synthetic answers may
apply the method to a new situation, but cannot invent Creator biography,
results, users, tools, or personal experience. Do not quote synthetic prose as
Creator-authored material.

After expansion, classify only the high-signal examples that should shape live
behavior. A global judgment becomes a short system-prompt few-shot; a judgment
that belongs to one execution unit becomes a few-shot in that Skill's
reference. Keep broad factual examples in Knowledge and keep boundary tests
out of runtime context. Few-shots are demonstrations of behavior, not a second
Knowledge base and not a substitute for the product promise.

## 6. Create isolated held-outs

After QA is complete, generate new prompts that do not repeat or paraphrase QA.
Cover all four categories. For every held-out record:

- input-only prompt;
- expected behavior;
- observable decisions, actions, and omissions;
- generic-baseline failure risk;
- forbidden behavior;
- supporting source-fact or derived-rule IDs.

Keep expected behavior and checks in Factory review data. Later candidate and
baseline generation may receive only the input prompt and immutable Release.

## 7. Audit before compilation

The same executing Agent performs two passes: first a completeness self-audit,
then an adversarial pass that actively tries to disprove the draft. Do not add a
sub-Agent or multi-Agent orchestrator to the product workflow. Neither pass may
inspect old proof or a previous Release.

Check:

- every source fact is an exact substring at the declared provenance;
- every derived rule has two or more direct source supports and a real derivation;
- method citations resolve and cover sequence, quality, omissions, and boundaries;
- product claims and capabilities do not exceed intent or evidence;
- tool needs distinguish Factory ingestion from live Runtime execution;
- QA is useful, synthetic, grounded, and non-duplicative;
- held-outs are novel and isolated from QA/few-shots;
- no guarantee exceeds the product boundary;
- no unsupported Creator authority is introduced;
- no expected answer or old proof influenced the build.

Write `work/semantic-audit.md` with findings and repairs. Stop rather than fill a
gap with plausible content.
