#!/usr/bin/env python3
"""Generate an input-only Kimi baseline without Creator-private knowledge.

The baseline is bound to the same immutable Release and held-out input bytes as
the Creator Agent run, but it receives neither the Release system prompt,
protected Skill, RAG, few-shots, nor expected Eval checks.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

from model_profile import KIMI_MODEL, controls_for
from semantic_uat import KIMI_BASE_URL, atomic_write_json, complete, read_json


BASELINE_SYSTEM_PROMPT = """You are a capable general-purpose assistant.
Complete the user's requested work using only information supplied by the user.
Do not claim access to a particular Creator's private method, course, examples,
data, or judgment. Do not invent evidence, metrics, experience, or outcomes.
Return a useful deliverable rather than describing how a specialized agent
might do the work."""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-url", default=os.environ.get("OPENAI_BASE_URL", KIMI_BASE_URL))
    parser.add_argument("--api-key-env", default="MOONSHOT_API_KEY")
    parser.add_argument("--model", default=KIMI_MODEL)
    parser.add_argument("--stop-after", type=int)
    args = parser.parse_args()

    controls = controls_for(args.model, "candidate")
    key = os.environ.get(args.api_key_env)
    if not key:
        raise SystemExit(f"missing provider credential in {args.api_key_env}")

    public = read_json(args.release.resolve() / "public.json")
    inputs_bytes = args.inputs.read_bytes()
    inputs = json.loads(inputs_bytes)
    inputs_sha256 = "sha256:" + hashlib.sha256(inputs_bytes).hexdigest()
    result = {
        "kind": "independent_generic_baseline",
        "release_id": public["release_id"],
        "release_digest": public["digest"],
        "provider_base_url": args.base_url,
        "model": args.model,
        "model_controls": controls,
        "input_scope": [args.inputs.name],
        "creator_private_assets_exposed": False,
        "expected_answers_or_checks_exposed": False,
        "inputs_sha256": inputs_sha256,
        "outputs": [],
        "passed": False,
    }
    if args.output.is_file():
        checkpoint = read_json(args.output)
        if all(checkpoint.get(key_name) == result[key_name] for key_name in (
            "kind", "release_id", "release_digest", "provider_base_url",
            "model", "model_controls", "inputs_sha256",
        )):
            result["outputs"] = checkpoint.get("outputs", [])

    completed = {item["id"] for item in result["outputs"]}
    for item in inputs:
        if item["id"] in completed:
            continue
        response = complete(
            url=args.base_url,
            api_key=key,
            model=args.model,
            system=BASELINE_SYSTEM_PROMPT,
            user=item["input"],
            phase="generic_baseline",
            request_label=item["id"],
        )
        result["outputs"].append({"id": item["id"], "response": response})
        result["outputs"].sort(key=lambda row: row["id"])
        atomic_write_json(args.output, result)
        print(json.dumps({"checkpoint": item["id"], "completed": len(result["outputs"])}), flush=True)
        if args.stop_after is not None and len(result["outputs"]) >= args.stop_after:
            print(json.dumps({"paused": True, "completed": len(result["outputs"])}), flush=True)
            return

    expected_ids = {item["id"] for item in inputs}
    output_ids = {item["id"] for item in result["outputs"]}
    result["passed"] = len(output_ids) == len(result["outputs"]) and output_ids == expected_ids
    atomic_write_json(args.output, result)
    print(json.dumps({"passed": result["passed"], "outputs": len(result["outputs"]), "model": args.model}))
    if not result["passed"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
