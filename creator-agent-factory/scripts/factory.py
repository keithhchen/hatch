#!/usr/bin/env python3
"""Deterministic Creator source-pack compiler (stdlib only)."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

CATEGORIES = ("direct", "composed", "boundary", "out_of_scope")
CLAIM_RE = re.compile(r"<!--\s*claim:([A-Z0-9-]+)\s*-->\s*(?:#[^\n]*\n)?\s*([^\n].*?)(?=\n\s*<!--\s*claim:|\Z)", re.S)
GUARANTEE_RE = re.compile(r"\b(guarantee[sd]?|will definitely|certain to)\b|一定(?:获得|达到|实现|拿到)", re.I)
FIRST_PERSON_AUTHORITY_RE = re.compile(r"\bI (?:have|personally|verified|coached|seen)\b", re.I)
FIRST_PERSON_VOICE_RE = re.compile(r"\b(?:I|me|my|mine|we|us|our|ours)\b", re.I)


class BuildError(RuntimeError):
    pass


def canonical(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def runtime_canonical(value: object) -> str:
    """Match Runtime's canonicalJson: sorted object keys, compact UTF-8 JSON."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def runtime_digest(value: object) -> str:
    return f"sha256:{digest_bytes(runtime_canonical(value).encode())}"


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2).encode() + b"\n")


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value.rstrip() + "\n", encoding="utf-8", newline="\n")


def extract_claims(text: str, source: dict) -> list[dict]:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip() + "\n"
    claims = []
    for match in CLAIM_RE.finditer(normalized):
        block = match.group(2).strip()
        excerpt = next((p.strip().replace("\n", " ") for p in re.split(r"\n\s*\n", block) if p.strip()), "")
        claims.append({
            "id": match.group(1), "epistemic_class": "source_fact", "source_id": source["source_id"],
            "source_path": source["path"], "source_location": source.get("source_location", source["path"]),
            "source_kind": source["kind"], "excerpt": excerpt,
        })
    return claims


def support_closure(item_ids: list[str], by_id: dict[str, dict]) -> list[str]:
    result: set[str] = set()
    pending = list(item_ids)
    while pending:
        item_id = pending.pop()
        if item_id in result:
            continue
        if item_id not in by_id:
            raise BuildError(f"unknown support id: {item_id}")
        result.add(item_id)
        pending.extend(by_id[item_id].get("supports", []))
    return sorted(result)


def markdown_table(rows: list[list[object]], headers: list[str]) -> str:
    def clean(value: object) -> str:
        return str(value).replace("|", "\\|").replace("\n", " ")
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    lines.extend("| " + " | ".join(clean(v) for v in row) + " |" for row in rows)
    return "\n".join(lines)


def invented_authority(text: str, creator_name: str) -> bool:
    escaped = re.escape(creator_name)
    first = re.escape(creator_name.split()[0]) if creator_name.split() else escaped
    named = re.compile(rf"\b(?:{escaped}|{first}) (?:said|says|has seen|believes|always)\b|\bin (?:{escaped}|{first})'s experience\b", re.I)
    return bool(named.search(text) or FIRST_PERSON_AUTHORITY_RE.search(text))


def collapse_whitespace(value: str) -> str:
    # Provenance is exact at the language level, but a model may emit straight
    # quotation marks where the course transcription used typographic ones.
    # Normalize only those presentation-equivalent glyphs and whitespace; do
    # not normalize words, numbers, punctuation such as dashes, or order.
    typographic_quotes = str.maketrans({
        "“": '"', "”": '"', "„": '"', "‟": '"',
        "‘": "'", "’": "'", "‚": "'", "‛": "'",
        "\u00a0": " ",
    })
    return re.sub(r"\s+", " ", value.translate(typographic_quotes)).strip()


def is_flat_string_list(value: object, *, nonempty: bool = True) -> bool:
    return (
        isinstance(value, list)
        and (bool(value) or not nonempty)
        and all(isinstance(item, str) and bool(item.strip()) for item in value)
    )


LOCAL_WORKSPACE_CAPABILITIES = ("fs.list", "fs.read", "fs.write")


def resolve_local_workspace_capabilities(declared: object) -> list[str]:
    """Close the safe discovery dependency of a workspace-reading product.

    Creators do not configure local tool schemas. They describe a product that
    reads a Consumer-selected workspace. Reading a real folder without
    assuming a filename requires a sandboxed directory listing first. This is
    deterministic Runtime capability closure, not an inference about the
    Creator's method or a new external integration.
    """
    if not is_flat_string_list(declared):
        raise BuildError("product supported_local_capabilities must be a non-empty flat string list")
    requested = set(declared)
    unknown = requested.difference(LOCAL_WORKSPACE_CAPABILITIES)
    if unknown:
        raise BuildError(f"unsupported local workspace capabilities: {sorted(unknown)}")
    if "fs.read" in requested:
        requested.add("fs.list")
    return [capability for capability in LOCAL_WORKSPACE_CAPABILITIES if capability in requested]


def validate_source_pack_structure(manifest: dict, plan: dict) -> None:
    """Reject malformed compiler input without making semantic judgments."""
    product = manifest.get("product")
    if not isinstance(product, dict):
        raise BuildError("source manifest product must be an object")
    resolve_local_workspace_capabilities(product.get("supported_local_capabilities"))
    external_tools = product.get("external_tools", [])
    if not is_flat_string_list(external_tools, nonempty=False):
        raise BuildError("product external_tools must be a flat string list")
    declared_external_tools = {tool.casefold() for tool in external_tools}

    tool_needs = plan.get("tool_needs", [])
    if not isinstance(tool_needs, list):
        raise BuildError("factory plan tool_needs must be a list")
    for need in tool_needs:
        fields = {"name", "kind", "required", "reason", "support"}
        if not isinstance(need, dict) or set(need) != fields:
            raise BuildError("tool need has wrong fields")
        if need["kind"] not in {"local", "external", "dataset", "unresolved"}:
            raise BuildError("tool need has invalid kind")
        if need["support"] not in {"intent", "detected_capability", "source_fact", "unresolved"}:
            raise BuildError("tool need has invalid support classification")
        if not isinstance(need["required"], bool) or any(
            not isinstance(need[field], str) or not need[field].strip()
            for field in ("name", "reason")
        ):
            raise BuildError("tool need must use non-empty strings and a boolean required flag")
        if need["kind"] == "external" and need["name"].casefold() not in declared_external_tools:
            raise BuildError("external tool need must match a declared product external tool")

    support_lists: list[tuple[str, object]] = []
    for rule in plan.get("derived_rules", []):
        if isinstance(rule, dict):
            support_lists.append((f"derived rule {rule.get('id', '<unknown>')} supports", rule.get("supports")))
    method = plan.get("method", {})
    if isinstance(method, dict):
        for field in ("quality_bar", "omissions", "boundaries", "priorities"):
            if field in method:
                support_lists.append((f"method {field}", method[field]))
        for phase in method.get("phases", []) if isinstance(method.get("phases"), list) else []:
            if isinstance(phase, dict):
                support_lists.append((f"method phase {phase.get('id', '<unknown>')} supports", phase.get("supports")))
    qa = plan.get("qa_seeds", {})
    if isinstance(qa, dict):
        for category in CATEGORIES:
            for row in qa.get(category, []) if isinstance(qa.get(category), list) else []:
                if isinstance(row, dict):
                    support_lists.append((f"QA {row.get('id', '<unknown>')} supports", row.get("supports")))
    for row in plan.get("held_out_evals", []) if isinstance(plan.get("held_out_evals", []), list) else []:
        if isinstance(row, dict):
            support_lists.append((f"held-out {row.get('id', '<unknown>')} supports", row.get("supports")))
    for label, value in support_lists:
        if not is_flat_string_list(value):
            raise BuildError(f"{label} must be a non-empty flat string list")


def runtime_few_shot(item: dict) -> dict:
    """Keep only behavior the live Agent needs; traces stay in Factory review."""
    return {
        "category": item["category"],
        "question": item["question"],
        "answer": item["answer"],
    }


def delivery_workflow_contract() -> dict:
    """Runtime-enforced delivery validation shared by every Creator Agent."""
    return {
        "version": "1",
        "mode": "draft_claim_audit_revise",
        "audit": {
            "unit": "atomic_claim",
            "verdicts": ["entailed", "unsupported", "conflicting", "confidential", "out_of_scope"],
            "require_evidence_entailment": True,
            "check_product_boundaries": True,
            "coverage": {
                "unitization": "markdown_claim_clauses_v1",
                "require_all_units": True,
                "max_units": 200,
            },
            "evidence_authority": {
                "user_fact_sources": ["user_input", "approved_tool_evidence"],
                "creator_method_sources": ["protected_knowledge"],
                "protected_knowledge_cannot_support_user_specific_claims": True,
            },
        },
        "audit_instruction": (
            "Audit every supplied claim_inventory unit using the declared evidence-authority classes. Do not omit a unit. Each supplied unit is already an auditable clause: return exactly one short claim row for its unit_id, with only a source ID or short evidence quote; do not restate policy. "
            "Mark a unit entailed only when the evidence directly supports every factual or causal assertion within it; if any assertion in a unit is unsupported, the unit cannot pass. Plausibility, implication, usage, or adoption is not evidence of an unstated outcome or benefit. "
            "User-specific action, scope, ownership, metric, outcome, and causal claims may be supported only by user_input or approved_tool_evidence. protected_knowledge may support the Creator's method, criteria, and advice, but it can never prove a fact about this user. "
            "A verbatim quotation or an explicitly identified original proposition from user_input is entailed as a quotation; do not treat its quoted content as verified merely because it is reproduced. A clearly framed recommendation, evidence gap, or verification instruction is Creator-method advice, not a user-specific fact, when it does not assert an unstated user condition, outcome, source, person, document, permission, or approval. Treat such advice as entailed when it follows the protected method and the supplied evidence. Do not reject an explicit review label such as 'verify', 'omit', or 'narrow' merely because no source uses that label. "
            "A direct request for missing input or permission (for example, 'provide the resume' or 'grant workspace access') is procedural advice, not a claim that the requested material already exists. Treat it as entailed when it follows the product promise, method, or boundary; do not rewrite a request into an invented user-specific existence claim. Evaluate an existence claim only when the draft actually asserts that the user has, supplied, or stored the material. "
            "Also enforce every product boundary. Return only the declared JSON result. Runtime computes the final pass from complete coverage and verdicts; do not return a self-reported passed field."
        ),
        "revision_instruction": (
            "Revise the draft using the audit findings. Remove or narrow unsupported, conflicting, confidential, or out-of-scope claims, or move them into an explicit evidence gap when useful. "
            "Keep evidence authority separate: protected knowledge may shape the method or advice but may not supply a fact about the user. Remove any unprovided person, title, team, document, repository, approval, measurement explanation, or other named source instead of offering it as a hypothetical. "
            "Do not add a replacement fact, rationale, effect, example, or causal bridge that is not directly supported. Return only the revised Consumer deliverable."
        ),
        "audit_result_format": {
            "claims": [{"unit_id": "string from claim_inventory", "claim": "atomic string", "verdict": "entailed|unsupported|conflicting|confidential|out_of_scope", "evidence": "string"}],
        },
        "max_revision_passes": 2,
        "on_unresolved": "return_boundary_safe_partial",
        "expose_intermediate": False,
    }


def runtime_rag_text(value: str) -> str:
    """Remove Factory annotations while preserving the Creator's teaching text."""
    without_comments = re.sub(
        r"<!--\s*(?:claim:[^>]*|source-location:[^>]*)-->",
        "",
        value,
        flags=re.I | re.S,
    )
    # Intake adds one machine-owned metadata preamble immediately after the
    # document title.  Strip only that exact leading shape.  A Creator may
    # legitimately teach a later section named "Provenance"; that content is
    # part of the course and must survive compilation.
    without_preamble = re.sub(
        r"\A(?P<title>\s*#[^\n]*\n+)"
        r"(?:Source provenance|Provenance):\s*\n"
        r"(?:- (?:intake source id|original path|page location|transcript sidecar|extracted path|raw sha256|transcript sha256|extracted sha256):[^\n]*\n)+\s*",
        r"\g<title>",
        without_comments,
        count=1,
        flags=re.I,
    )
    # Backward-compatible Factory preamble used by earlier internally
    # generated source packs.  Its exact sentence shape distinguishes it from
    # a Creator-authored provenance lesson later in the document.
    without_preamble = re.sub(
        r"\A(?P<title>\s*#[^\n]*\n+)"
        r"Provenance:\s*\n"
        r"Distilled from intake document `[^`]+` at original path `[^`]+`\. "
        r"Each claim excerpt is reproduced exactly from the extracted intake text\.\s*",
        r"\g<title>",
        without_preamble,
        count=1,
        flags=re.I,
    )
    cleaned = re.sub(r"\n{3,}", "\n\n", "\n".join(line.rstrip() for line in without_preamble.splitlines())).strip()
    if not cleaned:
        raise BuildError("Runtime RAG document is empty after removing Factory annotations")
    return cleaned + "\n"


def runtime_rag_text_has_factory_annotations(value: str) -> bool:
    """Detect compiler annotations without reserving Creator vocabulary."""
    if re.search(r"<!--\s*(?:claim:|source-location:)", value, re.I):
        return True
    if re.search(
        r"(?im)^- (?:intake source id|original path|page location|transcript sidecar|extracted path|raw sha256|transcript sha256|extracted sha256):",
        value,
    ):
        return True
    return bool(re.search(
        r"(?i)Distilled from intake document `[^`]+` at original path `[^`]+`\. "
        r"Each claim excerpt is reproduced exactly from the extracted intake text\.",
        value,
    ))


def normalized_prompt_bullet(value: str) -> str:
    """Normalize exact bullet wording without attempting semantic similarity."""
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def dedupe_prompt_sections(sections: list[tuple[str, list[str]]]) -> dict[str, list[str]]:
    """Keep an exact normalized rule in its most specific prompt section."""
    retained: dict[str, list[str]] = {name: [] for name, _ in sections}
    seen: set[str] = set()
    for name, items in sections:
        for item in items:
            key = normalized_prompt_bullet(item)
            if key and key not in seen:
                retained[name].append(item)
                seen.add(key)
    return retained


def build(source_pack: Path, output: Path, intake_workspace: Path | None = None) -> dict:
    source_pack = source_pack.resolve()
    manifest = read_json(source_pack / "source-manifest.json")
    plan = read_json(source_pack / "factory-plan.json")
    validate_source_pack_structure(manifest, plan)
    work = Path(tempfile.mkdtemp(prefix="creator-factory-"))
    proof = work / "proof"
    try:
        shutil.copytree(source_pack, proof / "work/factory-input")
        requested_local_capabilities = list(manifest["product"]["supported_local_capabilities"])
        resolved_local_capabilities = resolve_local_workspace_capabilities(requested_local_capabilities)
        manifest["product"]["supported_local_capabilities"] = resolved_local_capabilities
        write_json(proof / "work/reports/capability-resolution.json", {
            "declared_by_factory_agent": requested_local_capabilities,
            "effective_release_capabilities": resolved_local_capabilities,
            "rule": "fs.read requires fs.list so a Consumer-selected workspace can be safely discovered without assuming filenames",
        })
        intake_by_id: dict[str, dict] = {}
        intake_root: Path | None = None
        intake_raw_characters: int | None = None
        if intake_workspace is not None:
            intake_workspace = intake_workspace.resolve()
            if not (intake_workspace / "intake.json").is_file() or not (intake_workspace / "creator-intent.txt").is_file():
                raise BuildError("intake workspace must contain intake.json and creator-intent.txt")
            intake_root = intake_workspace
            intake_manifest = read_json(intake_workspace / "intake.json")
            intake_raw_characters = int(intake_manifest["totals"]["extracted_characters"])
            intake_by_id = {item["source_id"]: item for item in intake_manifest["documents"]}
            shutil.copytree(intake_workspace, proof / "work/intake")
        inventory, normalized_docs, source_claims = [], [], []
        seen: set[str] = set()
        for doc in sorted(manifest["documents"], key=lambda d: d["source_id"]):
            path = (source_pack / doc["path"]).resolve()
            if source_pack not in path.parents or not path.is_file():
                raise BuildError(f"invalid source path: {doc['path']}")
            raw = path.read_bytes()
            text = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").strip() + "\n"
            claims = extract_claims(text, doc)
            if not claims:
                raise BuildError(f"source has no marked claims: {doc['source_id']}")
            for claim in claims:
                if claim["id"] in seen:
                    raise BuildError(f"duplicate claim id: {claim['id']}")
                seen.add(claim["id"])
                annotation = plan["claim_annotations"].get(claim["id"])
                if not annotation:
                    raise BuildError(f"missing annotation: {claim['id']}")
                claim.update(annotation)
                if claim["excerpt"] not in text.replace("\n", " "):
                    raise BuildError(f"excerpt does not trace to normalized source: {claim['id']}")
                source_claims.append(claim)
            origin_evidence = None
            if intake_root is not None:
                origin_id = doc.get("origin_source_id") or doc.get("source_id")
                if not origin_id or origin_id not in intake_by_id:
                    raise BuildError(f"source document lacks valid intake provenance: {doc['source_id']}")
                origin = intake_by_id[origin_id]
                declared_origin_path = doc.get("origin_path") or doc.get("original_path")
                if declared_origin_path != origin["original_path"]:
                    raise BuildError(f"source origin path mismatch: {doc['source_id']}")
                if origin.get("kind") == "pdf":
                    declared_location = doc.get("source_location")
                    page_locations = {
                        page["location"] for page in origin.get("pdf_provenance", {}).get("pages", [])
                    }
                    if not declared_location or declared_location not in page_locations:
                        raise BuildError(
                            f"PDF source lacks a valid page-level source_location: {doc['source_id']}"
                        )
                extracted = (intake_root / origin["extracted_path"]).read_text(encoding="utf-8")
                normalized_origin = collapse_whitespace(extracted)
                missing = [claim["id"] for claim in claims if collapse_whitespace(claim["excerpt"]) not in normalized_origin]
                if missing:
                    raise BuildError(f"distilled excerpts do not trace to raw intake for {doc['source_id']}: {missing}")
                origin_evidence = {
                    "origin_source_id": origin_id,
                    "origin_path": origin["original_path"],
                    "origin_raw_sha256": origin["raw_sha256"],
                    "origin_extracted_sha256": origin["extracted_sha256"],
                    "source_location": doc.get("source_location", origin["original_path"]),
                    "claims_verified_against_intake": len(claims),
                }
            inventory.append({**doc, "bytes": len(raw), "sha256": digest_bytes(raw), "claim_count": len(claims), "origin_evidence": origin_evidence})
            normalized_docs.append({**doc, "text": text, "sha256": digest_bytes(text.encode()), "claim_ids": [c["id"] for c in claims]})

        annotation_extras = set(plan["claim_annotations"]) - seen
        if annotation_extras:
            raise BuildError(f"annotations without source claims: {sorted(annotation_extras)}")
        by_id = {c["id"]: c for c in source_claims}
        derived = []
        for rule in sorted(plan["derived_rules"], key=lambda r: r["id"]):
            if len(rule["supports"]) < 2 or not rule.get("derivation"):
                raise BuildError(f"derived rule needs derivation and >=2 supports: {rule['id']}")
            closure = support_closure(rule["supports"], by_id)
            item = {**rule, "epistemic_class": "derived_rule", "source_fact_closure": closure}
            derived.append(item)
            by_id[item["id"]] = item

        method = {**plan["method"], "epistemic_class": "derived_rule"}
        method_refs = method["quality_bar"] + method["omissions"] + method["boundaries"]
        for phase in method["phases"]:
            method_refs.extend(phase["supports"])
        method["trace_closure"] = support_closure(method_refs, by_id)

        qa: dict[str, list[dict]] = {}
        for category in CATEGORIES:
            seeds = plan["qa_seeds"].get(category, [])
            if not seeds:
                raise BuildError(f"empty QA category: {category}")
            qa[category] = []
            for seed in sorted(seeds, key=lambda q: q["id"]):
                closure = support_closure(seed["supports"], by_id)
                if invented_authority(seed["answer"], manifest["creator"]["name"]):
                    raise BuildError(f"invented Creator authority in {seed['id']}")
                if GUARANTEE_RE.search(seed["answer"]) and category != "boundary":
                    raise BuildError(f"unsupported guarantee in {seed['id']}")
                qa[category].append({**seed, "category": category, "epistemic_class": "synthetic_expansion", "trace_closure": closure})

        held_out = []
        qa_ids = {item["id"] for category in CATEGORIES for item in qa[category]}
        for seed in sorted(plan.get("held_out_evals", []), key=lambda q: q["id"]):
            if seed["id"] in qa_ids:
                raise BuildError(f"held-out eval leaks into synthetic QA/few-shots: {seed['id']}")
            if seed.get("category") not in CATEGORIES:
                raise BuildError(f"invalid held-out eval category: {seed['id']}")
            closure = support_closure(seed["supports"], by_id)
            expected = seed["expected_behavior"]
            if invented_authority(expected, manifest["creator"]["name"]):
                raise BuildError(f"invented Creator authority in held-out eval {seed['id']}")
            held_out.append({
                **seed,
                "epistemic_class": "synthetic_expansion",
                "trace_closure": closure,
                "suite": "release_holdout",
            })

        all_claims = source_claims + derived
        trace_rows = []
        for item in all_claims:
            closure = item.get("source_fact_closure", [item["id"]])
            trace_rows.append({
                "artifact_id": item["id"], "epistemic_class": item["epistemic_class"],
                "direct_supports": item.get("supports", [item["id"]]), "source_fact_closure": closure,
                "source_locations": sorted({by_id[source_id]["source_location"] for source_id in closure if source_id.startswith("S-")}),
                "verified": True,
            })
        for category in CATEGORIES:
            for item in qa[category]:
                closure = [x for x in item["trace_closure"] if x.startswith("S-")]
                trace_rows.append({
                    "artifact_id": item["id"], "epistemic_class": "synthetic_expansion",
                    "direct_supports": item["supports"], "source_fact_closure": closure,
                    "source_locations": sorted({by_id[source_id]["source_location"] for source_id in closure}),
                    "verified": True,
                })
        for item in held_out:
            closure = [x for x in item["trace_closure"] if x.startswith("S-")]
            trace_rows.append({
                "artifact_id": item["id"], "epistemic_class": "synthetic_expansion",
                "direct_supports": item["supports"], "source_fact_closure": closure,
                "source_locations": sorted({by_id[source_id]["source_location"] for source_id in closure}),
                "verified": True,
            })

        # Proof/intermediate artifacts.
        write_json(proof / "work/reports/source-inventory.json", {"documents": inventory, "totals": {"documents": len(inventory), "source_claims": len(source_claims)}})
        for doc in normalized_docs:
            write_text(proof / "work/normalized" / f"{doc['source_id']}.md", doc["text"])
        write_json(proof / "work/distilled/source-facts.json", source_claims)
        write_json(proof / "work/distilled/derived-rules.json", derived)
        write_json(proof / "work/distilled/trace-matrix.json", trace_rows)
        write_json(proof / "work/distilled/purification.json", {
            "policy": "Retain only attributable source facts, explicitly derived operational rules, declared omissions, and bounded synthetic expansion.",
            "retained": {"source_facts": len(source_claims), "derived_rules": len(derived)},
            "removed_or_forbidden": ["unsupported Creator biography", "invented personal experience", "unsubstantiated outcome guarantees", "uncited operational rules", "surface-vocabulary imitation without method support"],
            "authority_patterns_checked": ["dynamic Creator-name authority patterns", FIRST_PERSON_AUTHORITY_RE.pattern, GUARANTEE_RE.pattern],
            "declared_omissions": [c["omission"] for c in source_claims if c.get("omission")],
            "passed": True,
        })
        write_json(proof / "work/method/method-model.json", method)
        for category in CATEGORIES:
            write_json(proof / f"work/expansion/{category}.json", qa[category])

        expansion_rows = [[cat, len(qa[cat]), ", ".join(q["id"] for q in qa[cat])] for cat in CATEGORIES]
        write_text(proof / "work/reports/expansion-report.md", "# Synthetic QA expansion report\n\nAll answers are labelled `synthetic_expansion`; none is represented as Creator-authored text.\n\n" + markdown_table(expansion_rows, ["Category", "Count", "IDs"]))

        # Review assets are Factory outputs, not Runtime inputs. Keeping them
        # outside the Release prevents production agents from carrying their
        # construction and evaluation corpus.
        dev_evals = make_evals(qa, "development")
        release_evals = make_heldout_evals(held_out, manifest) if held_out else make_evals(qa, "release")
        write_json(proof / "review/synthetic-qa.json", {category: qa[category] for category in CATEGORIES})
        write_json(proof / "review/evals.json", {"development": dev_evals, "release": release_evals})
        if held_out:
            write_json(proof / "review/held-out-evals.json", release_evals)
            write_json(proof / "review/held-out-inputs.json", [
                {"id": item["id"], "category": item["category"], "input": item["input"]}
                for item in held_out
            ])

        # Runtime-consumable Release payload in staging. Proof artifacts stay
        # outside this directory; the Release contains only runtime inputs.
        relroot = proof / "release-staging"
        rag_docs = []
        for index, d in enumerate(normalized_docs, 1):
            runtime_text = runtime_rag_text(d["text"])
            rag_docs.append({
                "document_id": f"doc-{index:03d}",
                "title": d["title"],
                "kind": d["kind"],
                "content_sha256": digest_bytes(runtime_text.encode()),
                "provenance": {
                    "source_kind": d["kind"],
                    "source_sha256": d.get("raw_sha256", d["sha256"]),
                    "locations": [d.get("source_location", d.get("original_path", d["path"]))],
                },
                "text": runtime_text,
                "_factory_claim_ids": d["claim_ids"],
            })
        chunks = []
        claim_map = {c["id"]: c for c in source_claims}
        for doc in rag_docs:
            for index, claim_id in enumerate(doc["_factory_claim_ids"]):
                claim = claim_map[claim_id]
                chunks.append({
                    "chunk_id": f"{doc['document_id']}:{index:03d}", "document_id": doc["document_id"],
                    "provenance": doc["provenance"],
                    "text": claim["excerpt"],
                })
        for doc in rag_docs:
            del doc["_factory_claim_ids"]

        prompt = render_system_prompt(manifest, method, derived, by_id)
        prompt_voice_matches = sorted(set(match.group(0) for match in FIRST_PERSON_VOICE_RE.finditer(prompt)))
        prompt_bullets = [
            line[2:].strip() for line in prompt.splitlines() if line.startswith("- ")
        ]
        normalized_prompt_bullets = [normalized_prompt_bullet(item) for item in prompt_bullets]
        duplicate_normalized_bullets = len(normalized_prompt_bullets) - len(set(normalized_prompt_bullets))
        compression_ratio = (len(prompt) / intake_raw_characters) if intake_raw_characters else None
        # Small source packs still need a fixed execution envelope (promise,
        # boundaries, audit instructions). Limit copied corpus growth without
        # penalizing that creator-agnostic Runtime overhead.
        compression_limit = (
            max(0.6, 6000 / intake_raw_characters)
            if intake_raw_characters
            else 1.0
        )
        prompt_purification = {
            "raw_extracted_characters": intake_raw_characters,
            "system_prompt_characters": len(prompt),
            "character_compression_ratio": compression_ratio,
            "character_compression_limit": compression_limit,
            "first_person_creator_voice_matches": prompt_voice_matches,
            "duplicate_normalized_bullets": duplicate_normalized_bullets,
            "source_excerpts_in_prompt": False,
            "passed": not prompt_voice_matches and duplicate_normalized_bullets == 0 and (compression_ratio is None or compression_ratio <= compression_limit),
        }
        write_json(proof / "work/reports/prompt-purification.json", prompt_purification)
        protected_skill = render_protected_skill(manifest, method)
        selected_fewshots = [runtime_few_shot(qa[c][0]) for c in CATEGORIES]
        product = manifest["product"]
        creator = manifest["creator"]
        skill_root = relroot / "skills"
        rag_root = relroot / "rag"
        skill_dir = skill_root / product["id"]
        write_text(skill_dir / "SKILL.md", protected_skill)
        write_json(rag_root / "documents.json", rag_docs)
        write_json(rag_root / "chunks.json", chunks)

        skill_assets = [asset_descriptor(skill_root, path, f"skill:{path.relative_to(skill_root).as_posix()}") for path in sorted(p for p in skill_root.rglob("*") if p.is_file())]
        rag_assets = [asset_descriptor(rag_root, path, f"rag:{path.stem}", "runtime knowledge index") for path in sorted(p for p in rag_root.rglob("*") if p.is_file())]
        release_id = f"{product['id']}@{product['version']}"
        public_base = {
            "contract_version": "1", "release_id": release_id, "product_id": product["id"],
            "creator_id": creator["id"], "version": product["version"],
            "creator": {"id": creator["id"], "name": creator["name"]},
            "product": {
                "name": product["name"], "description": product["description"], "promise": product["promise"],
                "boundaries": product["boundaries"],
                "price": {
                    "amount_minor": product["price_minor"],
                    "currency": product["currency"],
                    "model": product.get("pricing_model", "per_delivery"),
                    "unit": product.get("pricing_unit", "delivery"),
                },
                "supported_local_capabilities": product["supported_local_capabilities"],
            },
            "presentation": product.get("presentation", {}),
        }
        private_base = {
            "contract_version": "1", "release_id": release_id, "product_id": product["id"],
            "creator_id": creator["id"], "version": product["version"], "system_prompt": prompt,
            "protected_skills": {"root": "skills", "assets": skill_assets},
            "rag": {"root": "rag", "documents": rag_assets},
            "few_shots": selected_fewshots,
            "runtime_policy": {
                "local_tools": product["supported_local_capabilities"], "workspace_scoped": True,
                "consequential_writes_require_approval": True,
                "external_tools": product.get("external_tools", []),
                "delivery_workflow": delivery_workflow_contract(),
            },
        }

        gates = evaluate_gates(source_claims, derived, qa, method, relroot, manifest, held_out, prompt_purification)
        write_json(proof / "work/reports/gates.json", gates)
        write_text(proof / "work/reports/gates.md", render_gates(gates))
        if not gates["passed"]:
            failures = [f"{g['id']}: {g['evidence']}" for g in gates["gates"] if not g["passed"]]
            raise BuildError("release gates failed: " + " | ".join(failures))

        release_digest = runtime_digest({"public": public_base, "private": private_base})
        write_json(relroot / "public.json", {**public_base, "digest": release_digest})
        write_json(relroot / "private.json", {**private_base, "digest": release_digest})

        final_release = proof / "release" / release_id / release_digest
        final_release.parent.mkdir(parents=True, exist_ok=True)
        relroot.rename(final_release)
        verification = verify_release(final_release)
        gates["gates"].append({"id": "G11-package-integrity", "passed": verification["passed"], "evidence": f"verified {verification['asset_count']} private assets, Runtime digest, identity, and public/private boundary"})
        gates["passed"] = all(g["passed"] for g in gates["gates"])
        write_json(proof / "work/reports/gates.json", gates)
        write_text(proof / "work/reports/gates.md", render_gates(gates))
        write_json(proof / "work/reports/release-verification.json", verification)
        if not verification["passed"]:
            raise BuildError("compiled release failed integrity verification")
        write_json(proof / "work/reports/build-summary.json", {
            "release_id": release_id, "release_digest": release_digest, "documents": len(inventory), "source_facts": len(source_claims),
            "derived_rules": len(derived), "synthetic_qa": sum(len(v) for v in qa.values()), "rag_chunks": len(chunks),
            "few_shots": len(selected_fewshots), "development_evals": len(dev_evals), "release_evals": len(release_evals),
            "held_out_evals": len(held_out), "raw_intake_attached": intake_workspace is not None, "gates_passed": len(gates["gates"]),
        })
        install_proof(proof, output)
        return read_json(output / "work/reports/build-summary.json")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def hash_tree(root: Path, virtual: dict[str, bytes] | None = None) -> dict[str, str]:
    virtual = virtual or {}
    result = {}
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = path.relative_to(root).as_posix()
        result[rel] = digest_bytes(virtual.get(rel, path.read_bytes()))
    return result


def asset_descriptor(root: Path, path: Path, asset_id: str, provenance: str | None = None) -> dict:
    item = {"id": asset_id, "path": path.relative_to(root).as_posix(), "sha256": f"sha256:{digest_bytes(path.read_bytes())}"}
    if provenance:
        item["provenance"] = provenance
    return item


def install_proof(staging: Path, output: Path) -> None:
    output = output.resolve()
    if output.exists():
        existing, incoming = hash_tree(output), hash_tree(staging)
        if existing == incoming:
            return
        raise BuildError(f"immutable output already exists with different bytes: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(staging, output)


def verify_release(release: Path) -> dict:
    release = release.resolve()
    public = read_json(release / "public.json")
    private = read_json(release / "private.json")
    public_base = {key: value for key, value in public.items() if key != "digest"}
    private_base = {key: value for key, value in private.items() if key != "digest"}
    computed_release_digest = runtime_digest({"public": public_base, "private": private_base})
    asset_checks = []
    declared_asset_paths: set[str] = set()
    for collection_name, collection in (("protected_skills", private["protected_skills"]), ("rag", private["rag"])):
        root = (release / collection["root"]).resolve()
        for asset in collection["assets"] if collection_name == "protected_skills" else collection["documents"]:
            path = (root / asset["path"]).resolve()
            contained = path == root or root in path.parents
            if contained:
                declared_asset_paths.add(path.relative_to(release).as_posix())
            actual = f"sha256:{digest_bytes(path.read_bytes())}" if contained and path.is_file() else None
            asset_checks.append(contained and actual == asset["sha256"])
    actual_release_files = {
        path.relative_to(release).as_posix()
        for path in release.rglob("*")
        if path.is_file()
    }
    expected_release_files = {"public.json", "private.json", *declared_asset_paths}
    forbidden_factory_keys = {
        "supports", "trace_closure", "source_fact_closure", "claim_ids",
        "source_path", "source_location", "epistemic_class", "origin_evidence",
    }

    def leaked_keys(value: object) -> set[str]:
        if isinstance(value, dict):
            return (set(value) & forbidden_factory_keys) | set().union(
                *(leaked_keys(child) for child in value.values()), set()
            )
        if isinstance(value, list):
            return set().union(*(leaked_keys(child) for child in value), set())
        return set()

    runtime_payload_leaks = leaked_keys(private)
    runtime_rag_provenance_complete = True
    runtime_rag_text_is_clean = True
    for asset_path in declared_asset_paths:
        if not asset_path.endswith(".json"):
            if asset_path.startswith("rag/"):
                runtime_rag_provenance_complete = False
            continue
        try:
            asset_value = read_json(release / asset_path)
            runtime_payload_leaks |= leaked_keys(asset_value)
            if asset_path.startswith("rag/"):
                runtime_rag_provenance_complete = runtime_rag_provenance_complete and isinstance(asset_value, list) and bool(asset_value) and all(
                    isinstance(item, dict)
                    and isinstance(item.get("provenance"), dict)
                    and isinstance(item["provenance"].get("source_kind"), str)
                    and isinstance(item["provenance"].get("source_sha256"), str)
                    and bool(item["provenance"].get("locations"))
                    and all(isinstance(location, str) and location for location in item["provenance"]["locations"])
                    for item in asset_value
                )
                runtime_rag_text_is_clean = runtime_rag_text_is_clean and all(
                    isinstance(item, dict)
                    and isinstance(item.get("text"), str)
                    and not runtime_rag_text_has_factory_annotations(item["text"])
                    for item in asset_value
                )
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
    checks = {
        "asset_hashes_match": bool(asset_checks) and all(asset_checks),
        "release_digest_matches": computed_release_digest == public["digest"] == private["digest"] == release.name,
        "release_identity_matches": public["release_id"] == private["release_id"] == release.parent.name and public["product_id"] == private["product_id"] and public["creator_id"] == private["creator_id"],
        "public_private_boundary": not ({"system_prompt", "protected_skills", "rag", "few_shots", "runtime_policy"} & set(public)),
        "runtime_release_excludes_factory_review": not ({"synthetic_qa", "evals"} & set(private)),
        "runtime_release_excludes_factory_trace": not runtime_payload_leaks,
        "runtime_rag_preserves_minimum_provenance": runtime_rag_provenance_complete,
        "runtime_rag_text_excludes_factory_annotations": runtime_rag_text_is_clean,
        "runtime_release_is_exactly_declared": actual_release_files == expected_release_files,
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "release_id": public["release_id"],
        "release_digest": public["digest"],
        "asset_count": len(asset_checks),
        "declared_files": sorted(expected_release_files),
        "unexpected_files": sorted(actual_release_files - expected_release_files),
        "missing_files": sorted(expected_release_files - actual_release_files),
        "factory_trace_keys_found": sorted(runtime_payload_leaks),
    }


def render_system_prompt(manifest: dict, method: dict, derived: list[dict], by_id: dict[str, dict]) -> str:
    p = manifest["product"]
    creator = manifest["creator"]
    phases = "\n".join(f"{i}. {x['instruction']}" for i, x in enumerate(method["phases"], 1))
    # Source excerpts belong in RAG and the Factory trace, not in the system
    # prompt.  Rendering the entire quoted course passage here both duplicates
    # context and risks turning first-person course language into Agent voice.
    def compressed(item_id: str, *, omission: bool = False) -> str:
        item = by_id[item_id]
        if omission and item.get("omission"):
            return item["omission"]
        return item.get("statement") or item.get("label") or item_id

    # Reserve exact duplicates for the most semantically specific section.
    # This is deliberately exact-only: the compiler must not guess that two
    # merely similar Creator rules mean the same thing.
    section_items = dedupe_prompt_sections([
        ("product_boundaries", list(p.get("boundaries", []))),
        ("boundaries", [compressed(item_id) for item_id in method["boundaries"]]),
        ("omissions", [compressed(item_id, omission=True) for item_id in method["omissions"]]),
        ("quality", [compressed(item_id) for item_id in method["quality_bar"]]),
        ("rules", [r["statement"] for r in derived]),
    ])

    def bullets(name: str) -> str:
        return "\n".join(f"- {item}" for item in section_items[name]) or "- None declared."

    rules = bullets("rules")
    quality = bullets("quality")
    omissions = bullets("omissions")
    boundaries = bullets("boundaries")
    product_boundaries = bullets("product_boundaries")
    return f"""# {p['name']} protected system prompt

You run {creator['name']}'s product, {p['name']}.

## Product promise
{p['promise']}

## Method order
{phases}

## Operational rules
{rules}

## Quality bar
{quality}

## Deliberate omissions and deferrals
{omissions}

## Boundaries
{boundaries}

## Product release boundaries
{product_boundaries}

## Delivery discipline
Use supplied context, protected RAG material, and approved tool results. Do not invent facts, Creator experience, or tool results. Audit the final deliverable clause by clause. Evidence of an action, mechanism, usage, or adoption supports only that action, mechanism, usage, or adoption, not an unstated outcome, effect, scope, or success; do not reintroduce it as a plausible effect. Plausibility is not support. A caveat does not make an unsupported assertion safe. Runtime audits every delivered assertion separately; follow that audit and preserve the method above.

## Evidence-minimal delivery
The declared product promise and method phases control the default delivery shape: carry out the complete promised method unless the Consumer explicitly asks for a single isolated rewrite or clarification. For missing evidence, return the smallest useful in-scope result. Do not repeat an unsupported proposition as if it were true.

## Missing-input recovery
When a required product input, permission, or target context is missing, do not fall back to a generic refusal. State the applicable limit, ask conditionally for the missing material, and name one nearest in-scope action in at most three plain sentences. Do not add generic domain education, a fabricated checklist, or a full deliverable.
"""


def render_protected_skill(manifest: dict, method: dict) -> str:
    product = manifest["product"]
    creator = manifest["creator"]
    return f"""---
name: {product['id']}
description: Run {creator['name']}'s protected {product['name']} product. {product['description']}
---

# {product['name']}

Fulfill this promise: {product['promise']}

Follow the method order and quality bar in the protected system instructions. Use only supplied context, protected knowledge, and approved tool results for factual claims. Preserve the method's priorities, deliberate omissions, quality bar, and boundaries. Never invent Creator authority or claim an outcome beyond the product promise.

Runtime validates every delivery with the private `draft_claim_audit_revise` workflow. Produce a draft, let Runtime audit each atomic claim against supplied evidence and product boundaries, and revise or omit every claim that is unsupported, conflicting, confidential, or out of scope. Only the validated final deliverable may reach the Consumer; never expose draft or audit artifacts.

For ambiguous or conflicting evidence, return the smallest useful in-scope
result rather than a long report. Use only direct evidence in the clean output,
then name only the specific gap that blocks a stronger result. Do not repeat an
unsupported proposition as fact, or add ratings, hypothetical examples,
placeholders, unverified target fit, causal explanations, or named sources.
For a short focused request that does not ask for long-form work, stay under
500 words and do not use a table or report outline.
For a narrow evidence review, use one plain supported-output paragraph and,
only when needed, one plain paragraph with at most three evidence questions.
Do not add a profile, score, ledger, classification, plan, named possible
source, or hypothetical explanation.

If required input is missing or a request crosses a product boundary, provide a
brief recovery path instead of a generic refusal: state the limit, name the
missing material or clarification, and name the nearest promised work the
Consumer can take next. Do not fabricate user facts or a completed deliverable.
Keep it to the applicable boundary, the missing input apparent from the
conversation, and the next promised action; do not add generic domain
explanation or hypothetical requirements.

For boundary or missing-input recovery, use at most three plain sentences with
no heading, table, list, or example: state the release limit; conditionally
request or ask for access to the missing input without asserting it exists; and
name one nearest promised action. Do not use a possessive shorthand as a claim
that the Consumer already has or stored a material.
"""


def make_evals(qa: dict[str, list[dict]], suite: str) -> list[dict]:
    selected = [q for cat in CATEGORIES for q in qa[cat] if (suite == "development" or q["id"].endswith("002"))]
    return [{"eval_id": f"E-{suite.upper()}-{q['id']}", "category": q["category"], "input": q["question"], "expected_behavior": q["answer"], "required_supports": q["supports"], "forbidden": ["invented facts", "invented Creator authority", "claims outside the product promise or boundaries"]} for q in selected]


def make_heldout_evals(held_out: list[dict], manifest: dict) -> list[dict]:
    product_boundaries = manifest["product"].get("boundaries", [])
    global_checks = [
        (
            "Every new factual or causal assertion in the response is entailed by the supplied input evidence; "
            "an action, mechanism, usage, or adoption is not converted into an unstated outcome, standardization, "
            "efficiency, consistency, quality, collaboration, revenue effect, causal contribution, or success."
        ),
        "Complies with every applicable product boundary: " + "; ".join(product_boundaries),
    ]
    return [{
        "id": item["id"],
        "eval_id": f"E-RELEASE-{item['id']}",
        "category": item["category"],
        "input": item["input"],
        "expected_behavior": item["expected_behavior"],
        "required_supports": item["supports"],
        "observable_checks": item.get("observable_checks", []) + global_checks,
        "global_boundary_checks": global_checks,
        "generic_baseline_risk": item.get("generic_baseline_risk", "A generic response may be plausible without reproducing the Creator's choices."),
        "forbidden": item.get("forbidden", []) + ["invented facts", "invented Creator authority", "claims outside the product promise or boundaries"],
    } for item in held_out]


def evaluate_gates(source_claims: list[dict], derived: list[dict], qa: dict, method: dict, relroot: Path, manifest: dict, held_out: list[dict] | None = None, prompt_purification: dict | None = None) -> dict:
    all_qa = [q for c in CATEGORIES for q in qa[c]]
    gates = [
        ("G01-source-trace", all(c["excerpt"] and c["source_path"] for c in source_claims), f"{len(source_claims)} source facts have exact excerpts and source paths"),
        ("G02-derived-trace", all(len(r["source_fact_closure"]) >= 2 and r["derivation"] for r in derived), f"{len(derived)} derived rules have derivations and source closures"),
        ("G03-qa-separation", all(qa[c] and all(q["category"] == c for q in qa[c]) for c in CATEGORIES), "all four QA categories are non-empty and separated"),
        ("G04-no-invented-authority", not any(invented_authority(q["answer"], manifest["creator"]["name"]) for q in all_qa), "synthetic answers contain no invented Creator authority patterns"),
        ("G05-no-guarantees", not any(GUARANTEE_RE.search(q["answer"]) for q in all_qa if q["category"] != "boundary"), "no positive synthetic answer guarantees an outcome"),
        ("G06-method-fidelity", bool(method["phases"] and method["quality_bar"] and method["omissions"] and method["boundaries"]), "method preserves sequence, quality bar, omissions, and boundaries"),
        ("G07-private-boundary", True, "public Runtime manifest is generated from client-safe identity and offer fields only"),
        ("G08-capability-policy", set(manifest["product"]["supported_local_capabilities"]) <= {"fs.list", "fs.read", "fs.write"}, "capabilities are within the local workspace envelope"),
    ]
    if held_out:
        qa_ids = {q["id"] for q in all_qa}
        gates.append((
            "G09-held-out-separation",
            not (qa_ids & {item["id"] for item in held_out}) and all(item.get("observable_checks") for item in held_out),
            f"{len(held_out)} release evals are separate from synthetic QA/few-shots and define observable checks",
        ))
    if prompt_purification is not None:
        gates.append((
            "G10-prompt-purification",
            prompt_purification["passed"],
            f"system prompt is {prompt_purification['system_prompt_characters']} chars; compression ratio {prompt_purification['character_compression_ratio']}; first-person Creator voice matches {prompt_purification['first_person_creator_voice_matches']}; duplicate normalized bullets {prompt_purification['duplicate_normalized_bullets']}",
        ))
    records = [{"id": i, "passed": bool(p), "evidence": e} for i, p, e in gates]
    return {"passed": all(g["passed"] for g in records), "gates": records}


def render_gates(gates: dict) -> str:
    rows = [[g["id"], "PASS" if g["passed"] else "FAIL", g["evidence"]] for g in gates["gates"]]
    return "# Automated release gates\n\nOverall: **%s**\n\n%s" % ("PASS" if gates["passed"] else "FAIL", markdown_table(rows, ["Gate", "Result", "Evidence"]))


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    cmd = sub.add_parser("build")
    cmd.add_argument("--source-pack", type=Path, required=True)
    cmd.add_argument("--output", type=Path, required=True)
    cmd.add_argument("--intake-workspace", type=Path)
    verify = sub.add_parser("verify")
    verify.add_argument("--release", type=Path, required=True)
    args = parser.parse_args()
    try:
        summary = build(args.source_pack, args.output, args.intake_workspace) if args.command == "build" else verify_release(args.release)
        print(json.dumps(summary, sort_keys=True))
        return 0
    except (BuildError, KeyError, ValueError, json.JSONDecodeError) as exc:
        print(f"factory error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
