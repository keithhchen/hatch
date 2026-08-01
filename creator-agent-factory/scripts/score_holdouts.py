#!/usr/bin/env python3
"""Blindly score Creator Agent and generic baseline answers against holdouts."""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

from model_profile import KIMI_MODEL, controls_for

KIMI_BASE_URL = "https://api.moonshot.cn/v1"


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def read_json(path: Path) -> object:
    return json.loads(path.read_text())


def atomic_write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    os.replace(temporary, path)


def provider_json(*, url: str, key: str, model: str, payload: dict) -> dict:
    controls = controls_for(model, "blind_judge")
    request_body = {
        "model": model,
        **controls,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a strict evidence-based evaluator. Score each output only against each "
                    "observable check. A check passes only when the output clearly exhibits the behavior. "
                    "Do not reward plausible intent or information absent from the text. For evidence and "
                    "boundary checks, audit every new declarative and causal assertion in the output against "
                    "the supplied input. Usage or adoption does not entail an outcome or benefit. A response "
                    "fails the check if even one unsupported assertion appears, including as rationale, "
                    "summary, rewrite, or suggestion. Judge entailment, not keyword presence. Return JSON only."
                ),
            },
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
    }
    request = urllib.request.Request(
        url.rstrip("/") + "/chat/completions",
        data=canonical(request_body),
        headers={
            "authorization": f"Bearer {key}",
            "content-type": "application/json",
            "user-agent": "hatch-creator-agent-factory/1.0",
        },
        method="POST",
    )
    raw = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                raw = json.loads(response.read())["choices"][0]["message"]["content"]
            break
        except urllib.error.HTTPError as error:
            body = error.read().decode(errors="replace")
            if error.code != 429 or attempt == 3:
                raise RuntimeError(f"judge returned HTTP {error.code}: {body}") from error
            match = re.search(r"try again in ([0-9.]+)s", body, re.I)
            delay = min(float(match.group(1)) + 0.5, 60.0) if match else (20.0, 40.0, 60.0)[attempt]
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError, http.client.IncompleteRead, ConnectionError) as error:
            if attempt == 3:
                raise RuntimeError(f"judge transport failed after retries: {type(error).__name__}") from error
            time.sleep((2.0, 4.0, 8.0)[attempt])
    if raw is None:
        raise RuntimeError("judge did not return a result")
    return json.loads(raw)


def output_map(payload: dict) -> dict[str, str]:
    result = {}
    for item in payload["outputs"]:
        answer = item.get("response", item.get("output"))
        if not isinstance(answer, str):
            raise ValueError(f"missing output for {item.get('id')}")
        result[item["id"]] = answer
    return result


def validate_inputs_binding(*, candidate_payload: dict, baseline_payload: dict, inputs_bytes: bytes) -> str:
    """Fail closed unless both compared runs bind to the exact held-out input bytes."""
    exact_inputs_sha256 = "sha256:" + hashlib.sha256(inputs_bytes).hexdigest()
    if candidate_payload.get("inputs_sha256") != exact_inputs_sha256:
        raise ValueError("candidate is not bound to the exact held-out inputs")
    if baseline_payload.get("inputs_sha256") != exact_inputs_sha256:
        raise ValueError("baseline is not bound to the exact held-out inputs")
    return exact_inputs_sha256


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evals", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-url", default=os.environ.get("OPENAI_BASE_URL", KIMI_BASE_URL))
    parser.add_argument("--api-key-env", default="MOONSHOT_API_KEY")
    parser.add_argument("--model", default=KIMI_MODEL)
    args = parser.parse_args()

    judge_controls = controls_for(args.model, "blind_judge")
    key = os.environ.get(args.api_key_env)
    if not key:
        raise SystemExit(f"missing provider credential in {args.api_key_env}")
    evals = read_json(args.evals)
    inputs = read_json(args.inputs)
    candidate_payload = read_json(args.candidate)
    baseline_payload = read_json(args.baseline)
    evals_sha256 = "sha256:" + hashlib.sha256(args.evals.read_bytes()).hexdigest()
    candidate_sha256 = "sha256:" + hashlib.sha256(args.candidate.read_bytes()).hexdigest()
    baseline_sha256 = "sha256:" + hashlib.sha256(args.baseline.read_bytes()).hexdigest()
    candidate = output_map(candidate_payload)
    baseline = output_map(baseline_payload)
    eval_ids = {case["id"] for case in evals}
    input_ids = {case["id"] for case in inputs}
    if len(eval_ids) != len(evals) or len(input_ids) != len(inputs) or eval_ids != input_ids:
        raise ValueError("held-out eval and input IDs must be unique and identical")
    eval_input_by_id = {case["id"]: case["input"] for case in evals}
    if any(eval_input_by_id[item["id"]] != item["input"] for item in inputs):
        raise ValueError("held-out eval probes do not match the input-only file")
    if len(candidate) != len(candidate_payload["outputs"]) or len(baseline) != len(baseline_payload["outputs"]):
        raise ValueError("candidate or baseline contains duplicate output IDs")
    candidate_kind = candidate_payload.get("kind")
    if candidate_kind not in {"semantic_candidate_run", "live_runtime_candidate_run"} or candidate_payload.get("passed") is not True:
        raise ValueError("candidate run is not complete and passing")
    candidate_controls = controls_for(KIMI_MODEL, "candidate")
    reviewer_controls = controls_for(KIMI_MODEL, "delivery_audit")
    if candidate_kind == "semantic_candidate_run":
        if (
            candidate_payload.get("model") != KIMI_MODEL
            or candidate_payload.get("model_controls") != candidate_controls
            or candidate_payload.get("delivery_reviewer", {}).get("model") != KIMI_MODEL
            or candidate_payload.get("delivery_reviewer", {}).get("controls") != reviewer_controls
        ):
            raise ValueError("candidate evidence is not a complete Kimi 2.6-only semantic run")
    else:
        runtime = candidate_payload.get("model_runtime", {})
        if (
            candidate_payload.get("model") != KIMI_MODEL
            or runtime.get("provider") != "moonshot"
            or runtime.get("creator_model") != KIMI_MODEL
            or runtime.get("reviewer_model") != KIMI_MODEL
            or runtime.get("compaction_model") != KIMI_MODEL
            or "Rust-local tool execution" not in str(candidate_payload.get("execution_surface", ""))
        ):
            raise ValueError("candidate evidence is not a Kimi 2.6-only live Runtime run")
    if (
        baseline_payload.get("kind") != "independent_generic_baseline"
        or baseline_payload.get("passed") is not True
        or baseline_payload.get("model") != KIMI_MODEL
        or baseline_payload.get("model_controls") != candidate_controls
        or baseline_payload.get("creator_private_assets_exposed") is not False
        or baseline_payload.get("expected_answers_or_checks_exposed") is not False
    ):
        raise ValueError("baseline evidence is not an isolated Kimi 2.6 generic run")
    if set(candidate) != eval_ids:
        raise ValueError("candidate outputs do not exactly cover held-out evals")
    if set(baseline) != eval_ids:
        raise ValueError("baseline outputs do not exactly cover held-out evals")
    release_id = candidate_payload["release_id"]
    release_digest = candidate_payload["release_digest"]
    if baseline_payload.get("release_id") != release_id or baseline_payload.get("release_digest") != release_digest:
        raise ValueError("candidate and baseline are not bound to the same exact Release")
    exact_inputs_sha256 = validate_inputs_binding(
        candidate_payload=candidate_payload,
        baseline_payload=baseline_payload,
        inputs_bytes=args.inputs.read_bytes(),
    )

    cases = []
    if args.output.is_file():
        checkpoint = read_json(args.output)
        if (
            checkpoint.get("release_digest") == release_digest
            and checkpoint.get("judge") == {"base_url": args.base_url, "model": args.model, **judge_controls}
            and checkpoint.get("evals_sha256") == evals_sha256
            and checkpoint.get("inputs_sha256") == exact_inputs_sha256
            and checkpoint.get("candidate_sha256") == candidate_sha256
            and checkpoint.get("baseline_sha256") == baseline_sha256
        ):
            cases = checkpoint.get("cases", [])
    completed_ids = {case["id"] for case in cases}
    error_output = args.output.parent.parent / "work/reports/blind-judge-provider-errors.json"
    for case in evals:
        case_id = case["id"]
        if case_id in completed_ids:
            continue
        if case_id not in candidate or case_id not in baseline:
            raise ValueError(f"missing candidate or baseline output for {case_id}")
        candidate_label = "A" if int(hashlib.sha256(case_id.encode()).hexdigest(), 16) % 2 == 0 else "B"
        baseline_label = "B" if candidate_label == "A" else "A"
        try:
            judged = provider_json(
                url=args.base_url,
                key=key,
                model=args.model,
                payload={
                    "task": "Evaluate Output A and Output B independently for every numbered observable check.",
                    "input": case["input"],
                    "expected_behavior": case["expected_behavior"],
                    "observable_checks": case["observable_checks"],
                    "output_A": candidate[case_id] if candidate_label == "A" else baseline[case_id],
                    "output_B": candidate[case_id] if candidate_label == "B" else baseline[case_id],
                    "required_json": {
                        "A": [{"check_index": 1, "passed": True, "evidence": "short quote or precise absence"}],
                        "B": [{"check_index": 1, "passed": False, "evidence": "short quote or precise absence"}],
                    },
                },
            )
        except Exception as error:
            sanitized = re.sub(r"org_[a-z0-9]+", "<org>", str(error))[:2000]
            previous = read_json(error_output) if error_output.is_file() else {"errors": []}
            previous["errors"].append({"stage": "blind_judge", "input_id": case_id, "error": sanitized})
            atomic_write_json(error_output, previous)
            raise
        by_label = {}
        for label in ("A", "B"):
            rows = judged.get(label)
            if not isinstance(rows, list) or len(rows) != len(case["observable_checks"]):
                raise RuntimeError(f"judge returned wrong check count for {case_id}/{label}")
            normalized = []
            for index, (check, row) in enumerate(zip(case["observable_checks"], rows), 1):
                if row.get("check_index") != index or not isinstance(row.get("passed"), bool):
                    raise RuntimeError(f"judge returned malformed row for {case_id}/{label}/{index}")
                normalized.append({
                    "check": check,
                    "passed": row["passed"],
                    "evidence": str(row.get("evidence", "")),
                })
            by_label[label] = normalized
        candidate_checks = by_label[candidate_label]
        baseline_checks = by_label[baseline_label]
        cases.append({
            "id": case_id,
            "category": case["category"],
            "probe": case["input"],
            "expected_behavior": case["expected_behavior"],
            "creator_agent": {"answer": candidate[case_id], "checks": candidate_checks},
            "generic_baseline": {"answer": baseline[case_id], "checks": baseline_checks},
        })
        cases.sort(key=lambda row: row["id"])
        checkpoint_result = {
            "release_id": release_id,
            "release_digest": release_digest,
            "kind": "blind_observable_check_comparison",
            "judge": {"base_url": args.base_url, "model": args.model, **judge_controls},
            "blind_labeling": True,
            "evals_sha256": evals_sha256,
            "inputs_sha256": exact_inputs_sha256,
            "candidate_sha256": candidate_sha256,
            "baseline_sha256": baseline_sha256,
            "cases": cases,
            "passed": False,
        }
        atomic_write_json(args.output, checkpoint_result)
        print(json.dumps({"checkpoint": case_id, "completed": len(cases)}), flush=True)

    candidate_passes = sum(row["passed"] for case in cases for row in case["creator_agent"]["checks"])
    baseline_passes = sum(row["passed"] for case in cases for row in case["generic_baseline"]["checks"])
    total_checks = sum(len(case["creator_agent"]["checks"]) for case in cases)
    candidate_rate = candidate_passes / total_checks
    baseline_rate = baseline_passes / total_checks
    gate = {
        "minimum_creator_agent_check_pass_rate": 0.8,
        "requires_strict_improvement_over_generic_baseline": True,
        "creator_agent_threshold_passed": candidate_rate >= 0.8,
        "strict_improvement_passed": candidate_rate > baseline_rate,
    }
    gate["passed"] = gate["creator_agent_threshold_passed"] and gate["strict_improvement_passed"]
    result = {
        "release_id": release_id,
        "release_digest": release_digest,
        "kind": "blind_observable_check_comparison",
        "judge": {"base_url": args.base_url, "model": args.model, **judge_controls},
        "blind_labeling": True,
        "evals_sha256": evals_sha256,
        "inputs_sha256": exact_inputs_sha256,
        "candidate_sha256": candidate_sha256,
        "baseline_sha256": baseline_sha256,
        "cases": cases,
        "summary": {
            "total_checks": total_checks,
            "creator_agent": {"passed_checks": candidate_passes, "pass_rate": candidate_rate},
            "generic_baseline": {"passed_checks": baseline_passes, "pass_rate": baseline_rate},
            "delta": candidate_rate - baseline_rate,
        },
        "gate": gate,
        "passed": gate["passed"],
    }
    atomic_write_json(args.output, result)
    print(json.dumps({"passed": result["passed"], **result["summary"]}))
    if not result["passed"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
