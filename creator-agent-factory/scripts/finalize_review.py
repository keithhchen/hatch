#!/usr/bin/env python3
"""Apply internal evidence-audit corrections and render a release audit record.

This script is a deterministic verifier helper. It is not a Creator-facing
approval workflow and it does not perform semantic distillation.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def read(path: Path) -> dict:
    return json.loads(path.read_text())


def write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--blind-judge", type=Path, required=True)
    parser.add_argument(
        "--corrections",
        type=Path,
        help="Optional internal audit overrides. Omit when no overrides are needed.",
    )
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--comparison-output", type=Path, required=True)
    parser.add_argument("--review-json", type=Path, required=True)
    parser.add_argument("--review-markdown", type=Path, required=True)
    args = parser.parse_args()

    comparison = read(args.blind_judge)
    corrections = (
        read(args.corrections)
        if args.corrections
        else {
            "method": "Kimi blind judge retained without human overrides",
            "overrides": [],
        }
    )
    runtime = read(args.runtime)
    cases = {case["id"]: case for case in comparison["cases"]}
    for correction in corrections["overrides"]:
        checks = cases[correction["id"]][correction["subject"]]["checks"]
        row = checks[correction["check_index"] - 1]
        row["passed"] = correction["passed"]
        row["evidence"] = correction["evidence"]
        row["audit_reason"] = correction["reason"]

    candidate_passes = sum(
        row["passed"] for case in cases.values() for row in case["creator_agent"]["checks"]
    )
    baseline_passes = sum(
        row["passed"] for case in cases.values() for row in case["generic_baseline"]["checks"]
    )
    total = sum(len(case["creator_agent"]["checks"]) for case in cases.values())
    candidate_rate = candidate_passes / total
    baseline_rate = baseline_passes / total
    comparison["adjudication"] = {
        "method": corrections["method"],
        "blind_judge_result_retained_at": str(args.blind_judge),
        "override_count": len(corrections["overrides"]),
    }
    comparison["summary"] = {
        "total_checks": total,
        "creator_agent": {"passed_checks": candidate_passes, "pass_rate": candidate_rate},
        "generic_baseline": {"passed_checks": baseline_passes, "pass_rate": baseline_rate},
        "delta": candidate_rate - baseline_rate,
    }
    comparison["gate"] = {
        "minimum_creator_agent_check_pass_rate": 0.8,
        "requires_strict_improvement_over_generic_baseline": True,
        "creator_agent_threshold_passed": candidate_rate >= 0.8,
        "strict_improvement_passed": candidate_rate > baseline_rate,
    }
    comparison["gate"]["passed"] = all([
        comparison["gate"]["creator_agent_threshold_passed"],
        comparison["gate"]["strict_improvement_passed"],
        runtime["passed"],
        runtime["release_id"] == comparison["release_id"],
        runtime["release_digest"] == comparison["release_digest"],
    ])
    comparison["runtime_mechanics"] = {
        "passed": runtime["passed"],
        "release_id": runtime["release_id"],
        "release_digest": runtime["release_digest"],
        "execution_surface": runtime["execution_surface"],
        "worker_received_private_skill": runtime["observations"]["worker_received_private_skill"],
        "runs": len(runtime["runs"]),
    }
    comparison["passed"] = comparison["gate"]["passed"]
    write(args.comparison_output, comparison)

    review = {
        "release_id": comparison["release_id"],
        "release_digest": comparison["release_digest"],
        "decision": "ready" if comparison["passed"] else "needs_work",
        "semantic_comparison": comparison["summary"],
        "runtime_mechanics": comparison["runtime_mechanics"],
        "cases": list(cases.values()),
    }
    write(args.review_json, review)

    lines = [
        "# Creator Agent release audit",
        "",
        f"Release: `{review['release_id']}`  ",
        f"Digest: `{review['release_digest']}`  ",
        f"Decision: **{review['decision'].upper()}**",
        "",
        "## What was actually tested",
        "",
        f"- Creator Agent: {candidate_passes}/{total} observable checks ({candidate_rate:.1%}).",
        f"- Generic baseline: {baseline_passes}/{total} observable checks ({baseline_rate:.1%}).",
        f"- Improvement: {candidate_rate - baseline_rate:+.1%}.",
        f"- Runtime mechanics: {'PASS' if runtime['passed'] else 'FAIL'}; exact Release resolved, private Skill reached the worker, and {len(runtime['runs'])} runs completed.",
        "- Semantic comparison and runtime delivery both used live Kimi provider runs; the runtime check verifies mechanics, not semantic quality.",
    ]
    for case in cases.values():
        lines.extend(["", f"## {case['id']} · {case['category']}", "", "**Probe**", "", case["probe"], "", "**Creator Agent answer**", "", case["creator_agent"]["answer"], "", "**Generic baseline answer**", "", case["generic_baseline"]["answer"], "", "| Observable check | Creator Agent | Baseline |", "|---|---:|---:|"])
        for candidate_row, baseline_row in zip(case["creator_agent"]["checks"], case["generic_baseline"]["checks"]):
            check = candidate_row["check"].replace("|", "\\|")
            lines.append(f"| {check} | {'PASS' if candidate_row['passed'] else 'FAIL'} | {'PASS' if baseline_row['passed'] else 'FAIL'} |")
    args.review_markdown.parent.mkdir(parents=True, exist_ok=True)
    args.review_markdown.write_text("\n".join(lines) + "\n")

    print(json.dumps({"passed": comparison["passed"], "creator_agent": candidate_rate, "baseline": baseline_rate}))
    if not comparison["passed"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
