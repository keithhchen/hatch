#!/usr/bin/env python3
"""Generate held-out Agent answers without exposing expected answers or checks.

This is semantic evidence, not Runtime mechanics evidence. It loads only an
immutable Release and an input-only holdout file, then calls an OpenAI-compatible
provider once per input. The resulting answers can later be replayed through the
real Runtime to prove Release materialization and protocol behavior separately.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import signal
import time
import urllib.error
import urllib.request

from model_profile import KIMI_MODEL, controls_for

KIMI_BASE_URL = "https://api.moonshot.cn/v1"

# Keep a whole short consumer delivery in a small number of provider calls.
# Twelve atomic units comfortably fit the Kimi JSON budget while avoiding the
# latency and failure surface of one round trip per table cell.
AUDIT_BATCH_SIZE = 12
CACHE_KIND = "semantic_provider_success_cache_v1"


class IncompleteProviderResponse(RuntimeError):
    """A successful HTTP response that cannot safely become an evaluation result.

    Some compatible providers occasionally return an empty or non-terminal
    choice despite a 2xx status.  That is neither a valid answer nor evidence
    that the Release failed.  Keep this distinct from a semantic failure so
    callers can retry it without ever caching the incomplete response.
    """


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def read_json(path: Path) -> object:
    return json.loads(path.read_text())


def atomic_write_json(path: Path, value: object) -> None:
    """Replace a checkpoint only after its complete JSON is durable on disk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    os.replace(temporary, path)


def completion_controls(model: str, *, json_mode: bool) -> dict:
    return controls_for(model, "delivery_audit" if json_mode else "candidate")


def provider_cache_root(output: Path) -> Path:
    """Keep provider I/O cache beside Factory work, never review or Release."""
    return output.parent.parent / "work/provider-cache"


def provider_cache_namespace(
    *, release_digest: str, inputs_sha256: str,
    candidate_url: str, candidate_model: str,
    reviewer_url: str, reviewer_model: str,
) -> dict:
    return {
        "release_digest": release_digest,
        "inputs_sha256": inputs_sha256,
        "candidate": {
            "base_url": candidate_url,
            "model": candidate_model,
            "controls": completion_controls(candidate_model, json_mode=False),
        },
        "reviewer": {
            "base_url": reviewer_url,
            "model": reviewer_model,
            "controls": completion_controls(reviewer_model, json_mode=True),
        },
    }


def provider_request_identity(
    *, url: str, model: str, system: str, user: str,
    phase: str, request_label: str, response_format: object, controls: dict,
) -> dict:
    return {
        "url": url,
        "model": model,
        "system": system,
        "user": user,
        "phase": phase,
        "request_label": request_label,
        "response_format": response_format,
        "controls": controls,
    }


def complete_response_is_well_formed(answer: object, *, json_mode: bool) -> bool:
    if not isinstance(answer, str) or not answer.strip():
        return False
    if not json_mode:
        return True
    try:
        value = json.loads(answer)
    except (json.JSONDecodeError, TypeError):
        return False
    if not isinstance(value, dict) or set(value) != {"claims"} or not isinstance(value["claims"], list):
        return False
    allowed = {"entailed", "unsupported", "conflicting", "confidential", "out_of_scope"}
    return all(
        isinstance(row, dict)
        and set(row) == {"unit_id", "claim", "verdict", "evidence"}
        and isinstance(row["unit_id"], str)
        and isinstance(row["claim"], str)
        and row["verdict"] in allowed
        and isinstance(row["evidence"], str)
        for row in value["claims"]
    )


def successful_response_text(result: object, *, json_mode: bool) -> str:
    """Accept only a complete terminal text response; never cache truncation."""
    if not isinstance(result, dict) or not isinstance(result.get("choices"), list) or len(result["choices"]) != 1:
        raise IncompleteProviderResponse("provider returned a malformed response envelope")
    choice = result["choices"][0]
    if not isinstance(choice, dict) or choice.get("finish_reason") != "stop":
        raise IncompleteProviderResponse("provider returned a partial or non-terminal response")
    message = choice.get("message")
    answer = message.get("content") if isinstance(message, dict) else None
    if not complete_response_is_well_formed(answer, json_mode=json_mode):
        raise IncompleteProviderResponse("provider returned a malformed or empty answer")
    return answer.strip()


class ExactRequestCache:
    """Private, content-addressed cache for complete successful provider text."""

    def __init__(self, root: Path, namespace: dict):
        self.root = root
        self.namespace = namespace
        self.namespace_digest = hashlib.sha256(canonical(namespace)).hexdigest()

    def _path(self, request_identity: dict) -> Path:
        request_digest = hashlib.sha256(canonical(request_identity)).hexdigest()
        return self.root / self.namespace_digest / f"{request_digest}.json"

    def get(self, request_identity: dict, *, json_mode: bool) -> str | None:
        path = self._path(request_identity)
        try:
            entry = read_json(path)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return None
        if not isinstance(entry, dict) or entry.get("kind") != CACHE_KIND:
            return None
        if entry.get("namespace") != self.namespace or entry.get("request") != request_identity:
            return None
        response = entry.get("response")
        if not complete_response_is_well_formed(response, json_mode=json_mode):
            return None
        if entry.get("response_sha256") != "sha256:" + hashlib.sha256(response.encode()).hexdigest():
            return None
        return response

    def put(self, request_identity: dict, response: str, *, json_mode: bool) -> None:
        if not complete_response_is_well_formed(response, json_mode=json_mode):
            raise ValueError("refusing to cache malformed or partial provider response")
        atomic_write_json(self._path(request_identity), {
            "kind": CACHE_KIND,
            "namespace": self.namespace,
            "request": request_identity,
            "response": response,
            "response_sha256": "sha256:" + hashlib.sha256(response.encode()).hexdigest(),
        })


@contextmanager
def hard_wall_clock_deadline(seconds: int):
    """Bound total wall time even when a proxy keeps socket activity alive."""
    if not hasattr(signal, "setitimer") or not hasattr(signal, "SIGALRM"):
        yield
        return
    previous_handler = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, seconds)

    def expired(_signum, _frame):
        raise TimeoutError(f"provider call exceeded {seconds}s wall-clock deadline")

    signal.signal(signal.SIGALRM, expired)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, *previous_timer)
        signal.signal(signal.SIGALRM, previous_handler)


def release_context(release: Path) -> tuple[dict, str, list[dict], str, dict]:
    public = read_json(release / "public.json")
    private = read_json(release / "private.json")
    parts = [private["system_prompt"]]
    for asset in private["protected_skills"]["assets"]:
        asset_path = release / private["protected_skills"]["root"] / asset["path"]
        # The compiled system prompt already contains the normalized method
        # model. Include the Skill entry point, but do not duplicate large
        # reference files into the provider prompt.
        if asset_path.name == "SKILL.md":
            parts.append(f"\n## Protected asset: {asset['id']}\n{asset_path.read_text()}")
    few_shots = []
    for index, example in enumerate(private.get("few_shots", []), 1):
        question = example.get("question")
        answer = example.get("answer")
        if isinstance(question, str) and isinstance(answer, str):
            few_shots.append(f"Example {index}\nUser: {question}\nAssistant: {answer}")
    rag_chunks: list[dict] = []
    for asset in private["rag"]["documents"]:
        asset_path = release / private["rag"]["root"] / asset["path"]
        value = read_json(asset_path)
        if isinstance(value, list):
            rag_chunks.extend(item for item in value if isinstance(item, dict) and isinstance(item.get("text"), str))
    workflow = private.get("runtime_policy", {}).get("delivery_workflow")
    if not isinstance(workflow, dict) or workflow.get("mode") != "draft_claim_audit_revise":
        raise ValueError("Release does not declare the required delivery workflow")
    return public, "\n".join(parts), rag_chunks, "\n\n".join(few_shots), workflow


def relevant_rag(chunks: list[dict], query: str, limit: int = 2) -> str:
    terms = {term for term in re.findall(r"[a-z0-9%]+", query.lower()) if len(term) > 2}
    ranked = sorted(
        chunks,
        key=lambda item: (
            len(terms & set(re.findall(r"[a-z0-9%]+", item["text"].lower()))),
            item.get("chunk_id", ""),
        ),
        reverse=True,
    )[:limit]
    return "\n\n".join(
        f"[{item.get('chunk_id', 'rag')}] {item['text']}"
        for item in ranked
    )


def complete(
    *, url: str, api_key: str, model: str, system: str, user: str,
    json_mode: bool = False, phase: str = "provider_call", request_label: str = "",
    cache: ExactRequestCache | None = None,
) -> str:
    controls = completion_controls(model, json_mode=json_mode)
    payload = {
        "model": model,
        **controls,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    if json_mode:
        # Kimi 2.6 supports JSON object mode. Shape enforcement stays local so
        # the provider contract and the Factory's evidence contract are not
        # accidentally conflated.
        payload["response_format"] = {"type": "json_object"}
    def request_identity() -> dict:
        return provider_request_identity(
            url=url, model=model, system=system, user=user,
            phase=phase, request_label=request_label,
            response_format=payload.get("response_format"), controls=controls,
        )

    cached = cache.get(request_identity(), json_mode=json_mode) if cache is not None else None
    if cached is not None:
        return cached
    request = urllib.request.Request(
        url.rstrip("/") + "/chat/completions",
        data=canonical(payload),
        headers={
            "authorization": f"Bearer {api_key}",
            "content-type": "application/json",
            "user-agent": "hatch-creator-agent-factory/1.0",
        },
        method="POST",
    )
    result = None
    wall_timeout = 120 if json_mode else 240
    for attempt in range(4):
        try:
            with hard_wall_clock_deadline(wall_timeout):
                with urllib.request.urlopen(request, timeout=min(180, wall_timeout)) as response:
                    result = json.loads(response.read())
            answer = successful_response_text(result, json_mode=json_mode)
            if cache is not None:
                cache.put(request_identity(), answer, json_mode=json_mode)
            return answer
        except urllib.error.HTTPError as error:
            body = error.read().decode(errors="replace")
            retryable_json_failure = json_mode and error.code == 400 and "json_validate_failed" in body
            if (error.code != 429 and not retryable_json_failure) or attempt == 3:
                raise RuntimeError(f"{phase}/{model}/{request_label}/attempt-{attempt + 1}: provider returned HTTP {error.code}: {body}") from error
            match = re.search(r"try again in ([0-9.]+)s", body, re.I)
            delay = (
                (1.0, 2.0, 4.0)[attempt]
                if retryable_json_failure
                else (min(float(match.group(1)) + 0.5, 60.0) if match else (20.0, 40.0, 60.0)[attempt])
            )
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError, http.client.IncompleteRead, ConnectionError) as error:
            if attempt == 3:
                raise RuntimeError(f"{phase}/{model}/{request_label}: provider transport failed after retries: {type(error).__name__}") from error
            time.sleep((2.0, 4.0, 8.0)[attempt])
        except IncompleteProviderResponse as error:
            # Treat 2xx responses with empty, truncated, or malformed content
            # exactly like a transient provider failure.  In particular, do not
            # let an empty response be recorded as a failed Creator Release.
            if attempt == 3:
                raise RuntimeError(
                    f"{phase}/{model}/{request_label}: provider returned no complete response after retries: {error}"
                ) from error
            time.sleep((2.0, 4.0, 8.0)[attempt])
    if result is None:
        raise RuntimeError("provider did not return a result")
    raise RuntimeError("provider did not return a complete result")


def markdown_claim_units(draft: str, workflow: dict) -> list[dict]:
    """Create coverage anchors for all Consumer-visible Markdown prose."""
    lines = draft.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    units: list[str] = []
    for index, raw_line in enumerate(lines):
        line = raw_line.strip()
        if not line or re.fullmatch(r"(?:[-*_]\s*){3,}", line) or line.startswith("```"):
            continue
        if re.match(r"^#{1,6}\s+", line):
            continue
        line = re.sub(r"^>\s?", "", line)
        line = re.sub(r"^(?:[-*+]\s+|\d+[.)]\s+)", "", line)
        if "|" in line:
            cells = [cell.strip() for cell in line.strip("|").split("|")]
            if cells and all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in cells):
                continue
            next_line = next((candidate.strip() for candidate in lines[index + 1:] if candidate.strip()), "")
            next_cells = [cell.strip() for cell in next_line.strip("|").split("|")] if "|" in next_line else []
            if next_cells and all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in next_cells):
                continue
            fragments = cells
        else:
            fragments = [line]
        for fragment in fragments:
            if not fragment or re.fullmatch(r"[*_`\s]+", fragment):
                continue
            clauses = re.split(
                r"(?<=[.!?;。！？；])\s+|,\s+(?=(?:and|but|while|which|who|that|so|because)\b)",
                fragment,
                flags=re.I,
            )
            for clause in clauses:
                cleaned = clause.strip(" \t-*_")
                if cleaned and not re.fullmatch(r"[A-Za-z0-9 &/+-]{1,40}:", cleaned):
                    units.append(cleaned)
    maximum = workflow["audit"]["coverage"]["max_units"]
    if len(units) > maximum:
        raise RuntimeError(f"draft exceeds claim coverage limit: {len(units)} > {maximum}")
    if not units:
        raise RuntimeError("draft contains no auditable claim units")
    return [{"unit_id": f"U{index:03d}", "text": text} for index, text in enumerate(units, 1)]


def parse_claim_audit(raw: str, workflow: dict, claim_inventory: list[dict]) -> dict:
    result = json.loads(raw)
    allowed = set(workflow["audit"]["verdicts"])
    if not isinstance(result.get("claims"), list):
        raise RuntimeError(f"claim audit returned malformed result keys: {sorted(result) if isinstance(result, dict) else type(result).__name__}")
    for row in result["claims"]:
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("unit_id"), str)
            or not isinstance(row.get("claim"), str)
            or row.get("verdict") not in allowed
            or not isinstance(row.get("evidence"), str)
        ):
            shape = sorted(row) if isinstance(row, dict) else type(row).__name__
            raise RuntimeError(f"claim audit returned malformed claim row: {shape}")
    expected_ids = {item["unit_id"] for item in claim_inventory}
    returned_ids = {row["unit_id"] for row in result["claims"]}
    if returned_ids - expected_ids:
        raise RuntimeError("claim audit returned unknown claim unit")
    coverage_complete = returned_ids == expected_ids
    actually_passed = coverage_complete and all(row["verdict"] == "entailed" for row in result["claims"])
    result["coverage"] = {
        "complete": coverage_complete,
        "expected_unit_ids": sorted(expected_ids),
        "returned_unit_ids": sorted(returned_ids),
        "missing_unit_ids": sorted(expected_ids - returned_ids),
    }
    result["passed"] = actually_passed
    return result


def claim_audit_payload(*, user: str, protected_context: str, draft: str, workflow: dict, claim_inventory: list[dict] | None = None) -> dict:
    """Keep user evidence and Creator knowledge in distinct authority classes."""
    inventory = claim_inventory if claim_inventory is not None else markdown_claim_units(draft, workflow)
    return {
        "evidence_authority": workflow["audit"]["evidence_authority"],
        "user_input": user,
        "approved_tool_evidence": [],
        "protected_knowledge": protected_context,
        # The complete draft is already deterministically represented across
        # batches. Sending only this batch's visible text keeps provider usage
        # bounded without weakening the global coverage gate.
        "draft_deliverable": "\n".join(item["text"] for item in inventory),
        "claim_inventory": inventory,
        "required_json": workflow["audit_result_format"],
    }


def semantic_run_passed(*, inputs: list[dict], outputs: list[dict], workflow_traces: list[dict]) -> bool:
    """Require a successful delivery audit for every non-empty candidate output.

    A boundary-safe fallback is useful safety evidence, but it is not evidence that
    the compiled Creator Agent can functionally deliver the requested product.
    """
    expected_ids = {item["id"] for item in inputs}
    output_by_id = {item.get("id"): item for item in outputs}
    trace_by_id = {item.get("id"): item for item in workflow_traces}
    if set(output_by_id) != expected_ids or set(trace_by_id) != expected_ids:
        return False
    return all(
        bool(output_by_id[item_id].get("response"))
        and trace_by_id[item_id].get("passed") is True
        and trace_by_id[item_id].get("boundary_safe_partial") is not True
        for item_id in expected_ids
    )


def reconcile_semantic_checkpoints(*, outputs: list[dict], workflow_traces: list[dict]) -> tuple[list[dict], list[dict]]:
    """Keep only cases durably present in both sides of the checkpoint pair."""
    output_ids = {item.get("id") for item in outputs if isinstance(item, dict)}
    trace_ids = {item.get("id") for item in workflow_traces if isinstance(item, dict)}
    committed_ids = output_ids & trace_ids
    return (
        sorted((item for item in outputs if item.get("id") in committed_ids), key=lambda item: item["id"]),
        sorted((item for item in workflow_traces if item.get("id") in committed_ids), key=lambda item: item["id"]),
    )


def execute_delivery_workflow(
    *, url: str, api_key: str, model: str,
    reviewer_url: str, reviewer_api_key: str, reviewer_model: str,
    evidence_context: str, user: str, workflow: dict,
    audit_context: str | None = None, cache: ExactRequestCache | None = None,
) -> tuple[str, dict]:
    draft = complete(
        url=url, api_key=api_key, model=model, system=evidence_context,
        user=user, phase="creator_draft", cache=cache,
    )
    reviewer_protected_context = audit_context if audit_context is not None else evidence_context
    current = draft
    audit_history = []
    revisions = 0
    for pass_index in range(workflow["max_revision_passes"] + 1):
        inventory = markdown_claim_units(current, workflow)
        batch_audits = []
        for batch_start in range(0, len(inventory), AUDIT_BATCH_SIZE):
            batch = inventory[batch_start:batch_start + AUDIT_BATCH_SIZE]
            audit_payload = json.dumps(claim_audit_payload(
                user=user,
                protected_context=reviewer_protected_context,
                draft=current,
                workflow=workflow,
                claim_inventory=batch,
            ), ensure_ascii=False)
            batch_audit = None
            audit_structure_errors = []
            for audit_attempt in range(3):
                audit_raw = complete(
                    url=reviewer_url,
                    api_key=reviewer_api_key,
                    model=reviewer_model,
                    system=(
                    workflow["audit_instruction"]
                        + " Cover each unit with the minimum necessary atomic rows. Keep claim text short and evidence to a source ID or short quote; do not restate policy. Every row MUST contain unit_id, claim, verdict, and evidence."
                    ),
                    user=audit_payload,
                    json_mode=True,
                    phase="delivery_audit",
                    request_label=f"revision-{pass_index}/batch-{batch_start // AUDIT_BATCH_SIZE + 1}/structure-attempt-{audit_attempt + 1}",
                    cache=cache,
                )
                try:
                    batch_audit = parse_claim_audit(audit_raw, workflow, batch)
                    break
                except (json.JSONDecodeError, RuntimeError) as error:
                    audit_structure_errors.append(str(error))
                    if audit_attempt == 2:
                        raise RuntimeError(f"delivery audit batch remained structurally invalid after retries: {audit_structure_errors}") from error
            assert batch_audit is not None
            batch_audits.append(batch_audit)
        merged_claims = [claim for batch in batch_audits for claim in batch["claims"]]
        audit = {
            "passed": all(batch["passed"] for batch in batch_audits),
            "claims": merged_claims,
            "coverage": {
                "complete": all(batch["coverage"]["complete"] for batch in batch_audits),
                "expected_unit_ids": [item["unit_id"] for item in inventory],
                "returned_unit_ids": sorted({claim["unit_id"] for claim in merged_claims}),
                "missing_unit_ids": sorted(
                    {item["unit_id"] for item in inventory} - {claim["unit_id"] for claim in merged_claims}
                ),
            },
            "batch_count": len(batch_audits),
        }
        audit_history.append(audit)
        if audit["passed"]:
            return current, {"passed": True, "revision_passes": revisions, "audits": audit_history, "draft": draft}
        if pass_index == workflow["max_revision_passes"]:
            break
        current = complete(
            url=url,
            api_key=api_key,
            model=model,
            system=evidence_context + "\n\n## Runtime delivery revision\n" + workflow["revision_instruction"],
            user=json.dumps({
                "original_user_input": user,
                "draft_deliverable": current,
                "claim_audit": audit,
            }, ensure_ascii=False),
            phase="creator_revision",
            request_label=f"revision-{pass_index + 1}",
            cache=cache,
        )
        revisions += 1
    # The contract prefers a smaller safe delivery to returning an unvalidated
    # draft.  This fallback contains no domain claim and exposes no audit data.
    return (
        "I can’t produce a fully evidence-grounded deliverable from the supplied material without adding unsupported claims. Please provide the missing evidence or narrow the requested scope.",
        {"passed": False, "revision_passes": revisions, "audits": audit_history, "draft": draft, "boundary_safe_partial": True},
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-url", default=os.environ.get("OPENAI_BASE_URL", KIMI_BASE_URL))
    parser.add_argument("--api-key-env", default="MOONSHOT_API_KEY")
    parser.add_argument("--model", default=KIMI_MODEL)
    parser.add_argument("--reviewer-base-url")
    parser.add_argument("--reviewer-api-key-env")
    parser.add_argument("--reviewer-model", default=KIMI_MODEL)
    parser.add_argument("--stop-after", type=int, help="atomically checkpoint after N completed cases, then exit without marking the run passed")
    args = parser.parse_args()

    reviewer_url = args.reviewer_base_url or args.base_url
    reviewer_model = args.reviewer_model
    candidate_controls = completion_controls(args.model, json_mode=False)
    reviewer_controls = completion_controls(reviewer_model, json_mode=True)
    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        raise SystemExit(f"missing provider credential in {args.api_key_env}")
    reviewer_key_env = args.reviewer_api_key_env or args.api_key_env
    reviewer_api_key = os.environ.get(reviewer_key_env)
    if not reviewer_api_key:
        raise SystemExit(f"missing reviewer credential in {reviewer_key_env}")
    release = args.release.resolve()
    public, base_context, rag_chunks, few_shots, workflow = release_context(release)
    inputs_raw = args.inputs.read_bytes()
    inputs = json.loads(inputs_raw)
    input_digest = "sha256:" + hashlib.sha256(inputs_raw).hexdigest()
    result = {
        "release_id": public["release_id"],
        "release_digest": public["digest"],
        "kind": "semantic_candidate_run",
        "provider_base_url": args.base_url,
        "model": args.model,
        "model_controls": candidate_controls,
        "delivery_reviewer": {
            "base_url": reviewer_url,
            "model": reviewer_model,
            "controls": reviewer_controls,
        },
        "temperature": candidate_controls["temperature"],
        "input_scope": [args.inputs.name],
        "expected_answers_or_checks_exposed": False,
        "inputs_sha256": input_digest,
        "outputs": [],
        "passed": False,
    }
    cache = ExactRequestCache(
        provider_cache_root(args.output),
        provider_cache_namespace(
            release_digest=public["digest"],
            inputs_sha256=input_digest,
            candidate_url=args.base_url,
            candidate_model=args.model,
            reviewer_url=reviewer_url,
            reviewer_model=reviewer_model,
        ),
    )
    if args.output.is_file():
        checkpoint = json.loads(args.output.read_text())
        if (
            checkpoint.get("release_digest") == public["digest"]
            and checkpoint.get("inputs_sha256") == input_digest
            and checkpoint.get("model") == args.model
            and checkpoint.get("model_controls") == result["model_controls"]
            and checkpoint.get("delivery_reviewer", {}).get("model") == reviewer_model
            and checkpoint.get("delivery_reviewer", {}).get("base_url") == reviewer_url
            and checkpoint.get("delivery_reviewer", {}).get("controls") == reviewer_controls
        ):
            result["outputs"] = checkpoint.get("outputs", [])
    error_output = args.output.parent.parent / "work/reports/semantic-provider-errors.json"
    workflow_trace_output = args.output.parent.parent / "work/reports/semantic-delivery-workflow.json"
    workflow_trace_record = json.loads(workflow_trace_output.read_text()) if workflow_trace_output.is_file() else {}
    workflow_traces = (
        workflow_trace_record.get("cases", [])
        if workflow_trace_record.get("release_digest") == public["digest"]
        and workflow_trace_record.get("inputs_sha256") == input_digest
        and workflow_trace_record.get("creator_model") == args.model
        and workflow_trace_record.get("creator_controls") == candidate_controls
        and workflow_trace_record.get("reviewer_model") == reviewer_model
        and workflow_trace_record.get("reviewer_base_url") == reviewer_url
        and workflow_trace_record.get("reviewer_controls") == reviewer_controls
        else []
    )
    result["outputs"], workflow_traces = reconcile_semantic_checkpoints(
        outputs=result["outputs"], workflow_traces=workflow_traces
    )
    completed_ids = {item["id"] for item in result["outputs"]}
    traced_ids = {item["id"] for item in workflow_traces}
    for item in inputs:
        if item["id"] in completed_ids:
            continue
        try:
            retrieved = relevant_rag(rag_chunks, item["input"])
            evidence_context = (
                base_context
                + "\n\n## Retrieved knowledge\n"
                + retrieved
                + ("\n\n## Creator few-shots\n" + few_shots if few_shots else "")
            )
            audit_context = json.dumps({
                "product_promise": public.get("product", {}).get("promise", ""),
                "product_boundaries": public.get("product", {}).get("boundaries", []),
                "retrieved_creator_knowledge": retrieved,
                "creator_few_shots": few_shots,
            }, ensure_ascii=False)
            answer, workflow_trace = execute_delivery_workflow(
                url=args.base_url,
                api_key=api_key,
                model=args.model,
                reviewer_url=reviewer_url,
                reviewer_api_key=reviewer_api_key,
                reviewer_model=reviewer_model,
                evidence_context=evidence_context,
                user=item["input"],
                workflow=workflow,
                audit_context=audit_context,
                cache=cache,
            )
        except Exception as error:
            sanitized = re.sub(r"org_[a-z0-9]+", "<org>", str(error))[:2000]
            binding = {
                "release_digest": public["digest"], "inputs_sha256": input_digest,
                "creator_model": args.model, "creator_controls": candidate_controls,
                "reviewer_model": reviewer_model, "reviewer_controls": reviewer_controls,
                "creator_base_url": args.base_url, "reviewer_base_url": reviewer_url,
            }
            previous = json.loads(error_output.read_text()) if error_output.is_file() else {}
            if any(previous.get(key) != value for key, value in binding.items()):
                previous = {**binding, "errors": []}
            previous["errors"].append({"input_id": item["id"], "error": sanitized})
            atomic_write_json(error_output, previous)
            raise
        result["outputs"].append({"id": item["id"], "response": answer})
        if item["id"] not in traced_ids:
            workflow_traces.append({"id": item["id"], **workflow_trace})
            workflow_traces.sort(key=lambda row: row["id"])
            atomic_write_json(workflow_trace_output, {
                "release_digest": public["digest"],
                "inputs_sha256": input_digest,
                "workflow": workflow,
                "creator_model": args.model,
                "creator_controls": candidate_controls,
                "reviewer_model": reviewer_model,
                "reviewer_base_url": reviewer_url,
                "reviewer_controls": reviewer_controls,
                "cases": workflow_traces,
            })
        result["outputs"].sort(key=lambda output: output["id"])
        atomic_write_json(args.output, result)
        print(json.dumps({"checkpoint": item["id"], "completed": len(result["outputs"])}), flush=True)
        if args.stop_after is not None and len(result["outputs"]) >= args.stop_after:
            print(json.dumps({"paused": True, "completed": len(result["outputs"])}), flush=True)
            return
    result["passed"] = semantic_run_passed(
        inputs=inputs,
        outputs=result["outputs"],
        workflow_traces=workflow_traces,
    )
    atomic_write_json(args.output, result)
    print(json.dumps({"passed": result["passed"], "outputs": len(result["outputs"]), "model": args.model}))


if __name__ == "__main__":
    main()
