sed: --: No such file or directory
# Factory routing few-shots

These examples teach the Factory how to place Creator material. They are
Factory behavior examples, not Creator content and must never be copied into a
published Agent Corpus.

## Global behavior belongs in `instructions/system.md`

**Material**

> A presentation is a communication tool between the person making it and the
> people who must understand or approve it. Start with the conclusion, then
> choose only the evidence needed to support it.

**Factory decision**

Put this in the system instructions. It defines the Agent's general way of
thinking and communicating across every presentation task.

## A local execution method belongs in a Skill

**Material**

> For a slide-structure task, turn one conclusion into a claim, supporting
> reasons, and the evidence needed for each reason.

**Factory decision**

Create a reusable `deck-structure` Skill only if the product actually promises
this execution unit. Do not make the entire presentation service one Skill.

## A local framework belongs in a Skill reference

**Material**

> Use the pyramid principle when decomposing a slide argument. Put the answer
> first and group supporting reasons at the same level.

**Factory decision**

Put this in `skills/deck-structure/references/pyramid-principle.md`. It matters
when that Skill runs; it is not a global rule for every Creator product.

## Long-tail material belongs in Knowledge

**Material**

> A 2024 industry report lists the market terms, companies, and historical
> examples used in this sector.

**Factory decision**

Put the report in `knowledge/` for retrieval. Do not turn its facts into
behavior rules or few-shots unless the Creator explicitly teaches a judgment
that should change the Agent's behavior.

## Scope decides ambiguous placement

**Material**

> Write titles as conclusions, not topics.

**Factory decision**

If the Creator applies this to every deliverable, put it in the system
instructions. If it is only a presentation-writing preference, put it in the
relevant Skill reference. Do not promote a local preference to a global rule
without evidence of global scope.

## Few-shot routing

An example that demonstrates a global judgment belongs in the system
instructions. An example that demonstrates one Skill's execution belongs in
that Skill's reference. A rare factual or edge-case example belongs in
Knowledge, while held-out examples remain evaluation inputs and never enter
runtime context.
