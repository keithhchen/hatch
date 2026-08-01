# Agent distillation workflow

Perform this semantic work as the executing Factory Agent after reading the
complete normalized intake. It is neither a script nor a Creator form. The only
publishable result is a clean Agent Corpus.

## 1. Establish the product boundary

Read the natural-language intent before interpreting the material. Decide:

- who pays and what usable work or experience they receive;
- the minimum Consumer input or local context required;
- what is out of scope and which real-world results must not be guaranteed;
- what the Agent delivers and whether the offer is per delivery or subscription
  when the Creator states it.

Do not begin with a digital twin. Begin with one bounded value proposition and
extract only the Creator ability needed to fulfil it.

## 2. Build private evidence

Read every extracted source. Privately retain exact material that changes a
decision, priority, sequence, quality bar, omission, boundary, output, or
example. Keep Creator fact and your interpretation distinct.

Do not turn a thin label (role, goal, industry) into a detailed customary
framework. Creator method, Consumer task material, and generic domain knowledge
are different things. When outside context would change the Creator's judgment,
ask only for the smallest concrete missing material and offer the nearest useful
partial delivery.

The evidence ledger is a reasoning aid. Do not publish quotations, claim IDs,
source paths, or the ledger itself.

## 3. Distill, purify, and route the ability

Identify the Creator's phases, ordering, priorities, tie-breakers, quality bar,
rare but decision-changing details, deliberate omissions, and boundaries. Then
classify each usable result by runtime need:

1. **Global** — Would this change how the Agent should behave on any relevant
   turn? Put it in `instructions/system.md`: worldview, voice, product promise,
   universal communication principles, global behavior, and concise global
   few-shots.
2. **Local** — Is this a distinct, repeatable execution unit needed only for a
   certain kind of request? Create a Skill only if yes. Give it a narrow trigger,
   inputs, outputs, steps, checks, and only the allowed tools. Do not create one
   Skill for the entire delivery.
3. **Local reference** — Is this a framework, aesthetic, method, or example that
   must direct a particular Skill but should not shape every turn? Put it in
   `skills/<id>/references/`. For example, a PPT structure Skill can load the
   Pyramid Principle reference; the global belief that a deck is a communication
   and alignment instrument belongs in `system.md`.
4. **Retrieval evidence** — Is this long-tail material that is useful only when a
   specific question needs it? Put a clean, queryable version in `knowledge/`.
   It must not contain global rules, Skill procedure, or raw course archive.

Omit a layer when it has no real job. A simple Agent may need only a system
prompt and tools. Do not create Skills, references, or knowledge merely for
symmetry. Never move a behavioral rule to retrieval simply to make the prompt
shorter.

Derive an operational rule only when Creator evidence supports it. Do not claim
generic good practice is this Creator's method.

## 4. Determine data and tool needs

Separate Factory ingestion, Hatch built-ins, Consumer-local capabilities,
Creator integrations, and Creator knowledge.

- `hatch.web_search` is always declared as a Hatch built-in.
- Use `hatch.local.files` only if the product needs actual Consumer workspace
  files or must save an artifact. Put that tool in the active local Skill's
  `allowed_tool_ids` when a Skill invokes it; a no-Skill Agent declares it only
  in its manifest. Do not make the Consumer paste a document by default.
- Creator HTTP/MCP integrations need a real product need. Declare only the
  Hatch-managed `connection_ref`, one permitted `operation` / `tool_name`, and
  an optional input schema; never credentials or URLs.
- Keep content that is too long to stay in context, but may be useful as
  evidence for a specific request, in clean agent-scoped `knowledge/`.

Do not turn a model action, extraction utility, or ordinary chat into a tool.

## 5. Expand synthetic QA without confusing it for context

Freeze the distilled method first. Expand beyond the course into likely direct,
composed, boundary, and out-of-scope requests; cover each category with at
least two synthetic QA cases. The expansion may cover plausible boundaries and
extensions, but cannot invent Creator biography, results, users, integrations,
or personal experience.

Route the *learning* from each case rather than dumping all cases into a prompt:

- global behavioral lesson → concise rule or few-shot in `system.md`;
- local execution lesson → Skill or that Skill's reference;
- long-tail edge/example → `knowledge/` when retrieval is genuinely appropriate.

Store synthetic QA and held-outs as separate JSON assets under `evals/`; neither
is automatically runtime context. After QA is frozen, make separate held-outs
for all four categories. Held-outs are input-only tests and never become
few-shots, references, or knowledge.

## 6. Audit the finished Corpus

Perform a normal self-audit, then an adversarial pass. Confirm:

- system guidance contains all and only global behavior;
- every Skill is local, executable, and optional by necessity rather than
  ceremony; references are only loaded with their Skill;
- knowledge is clean retrieval evidence rather than policy, prompt, or raw
  source;
- synthetic QA has been correctly routed and held-outs are isolated;
- product claims, tool needs, and expected behavior stay within evidence and
  the product boundary;
- no raw source, Factory trace, credentials, URL, provider setting, deployment
  setting, review workflow, release, or version entered the Corpus.

Repair the Corpus, not the source. Omit unsupported content or state its limit.
