# Release contract

Only `release/<release-id>/<sha256:digest>/` crosses from Factory to
Runtime/Registry. Factory proof, original course assets, normalized working
corpus, traces, and rejected drafts remain outside this directory.

- `public.json` is client-safe and contains identity, offer, presentation,
  capabilities, version, and digest.
- `private.json` is server-only and contains only what a live Agent needs: the
  system prompt, protected Skill and RAG asset descriptors, selected few-shots,
  and runtime policy.
- `skills/` and `rag/` contain only the private assets referenced by
  `private.json`. Each descriptor carries its own SHA-256 digest.

The Release is an execution package, not a Factory export. It must not contain
claim IDs, support closures, Factory source-path fields, epistemic labels,
Evals, review results, extraction metadata, or rejected drafts. Keep those in
`work/` and `review/`. Runtime few-shots contain only category, question, and
answer.

Version 1 has exactly five deployable files: `public.json`, `private.json`, one
`skills/<product-id>/SKILL.md`, `rag/documents.json`, and `rag/chunks.json`.
Source count, source format, course modules, and Factory stage count must never
change that shape.

Runtime RAG must retain minimum provenance without importing the Factory trace
schema. Every document and chunk carries a generic `provenance` object with
`source_kind`, `source_sha256`, and one or more `locations` such as an original
file, `file.pdf#page=N`, or media timestamp. This is execution-time evidence
for retrieval and citation; support closures and claim IDs remain Factory-only.

The Factory output has exactly three top-level concerns:

- `release/`: the immutable package that can cross into Runtime/Registry;
- `review/`: synthetic QA, Evals, and representative run results used for the
  Creator's release decision;
- `work/`: extraction, normalized sources, distillation traces, rejected
  material, and build verification retained by Factory.

Runtime never loads `review/` or `work/` as part of the live Agent.

Every private Release declares `runtime_policy.delivery_workflow`. Version 1
uses `draft_claim_audit_revise`: Runtime drafts the deliverable, audits every
atomic claim against the user input, approved tool evidence, protected RAG, and
product boundaries, then revises any unsupported, conflicting, confidential,
or out-of-scope claim. Runtime repeats the audit up to the declared limit and
returns a boundary-safe partial result when unresolved claims remain. Drafts
and audit records are server-private and never reach the Consumer.

Runtime does not trust the reviewer to discover every claim. It deterministically
unitizes the full draft with `markdown_claim_clauses_v1`, supplies the complete
claim inventory, and rejects missing or unknown unit IDs. A draft above the
declared unit limit fails closed rather than being truncated.

Evidence authority remains separated throughout that workflow. User-specific
actions, ownership, scope, metrics, outcomes, and causal claims may be supported
only by the user's input or approved tool evidence. Protected Creator knowledge
may determine the method, criteria, or advice, but can never prove a fact about
the current user.

`release/` is the product output. `review/` and `work/` are Factory-side
records, not fields or assets of the generated Agent. A Release verifier rejects
any undeclared file, so source manifests, raw course files, Evals, traces,
reports, and rejected drafts cannot accidentally travel with the Agent.

Decoupling applies to the contract and compiler, not to the Agent's content.
The same generic Release shape carries each Creator's own identity, promise,
method, knowledge, tools, and presentation. Adding a new Creator or domain may
change those values and private assets, but must not require a new manifest
shape, domain-specific field, Factory branch, or Runtime code path.

The public price is generic commerce metadata: `amount_minor`, `currency`,
`model` (`per_delivery` or `subscription`), and a Creator-defined `unit` such
as `review`, `plan`, or `month`. Factory code must not encode domain-specific
units.

The release digest is SHA-256 over Runtime-canonical JSON of `public.json` and
`private.json` with their `digest` fields omitted. Release ID is
`<product-id>@<semver>`; digest is a separate `sha256:<64-hex>` identity.

A registry must treat `(release_id, digest)` as immutable. Runtime independently
validates the public/private schemas, recomputes the Release digest, verifies
every private asset hash and containment boundary, and materializes the exact
same digest. Consumer payloads never contain system prompt, Skill/RAG paths,
  tool policy, Factory review material, or source traces.
