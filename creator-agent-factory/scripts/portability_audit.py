#!/usr/bin/env python3
"""Prove two raw-input builds share one contract without sharing scenario content."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re


def read(path: Path) -> dict:
    return json.loads(path.read_text())


def sha(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def release_shape(release: Path, product_id: str) -> list[str]:
    result = []
    for path in release.rglob("*"):
        if path.is_file():
            relative = path.relative_to(release).as_posix()
            result.append(relative.replace(f"skills/{product_id}/", "skills/<product-id>/"))
    return sorted(result)


def raw_boundary(root: Path) -> dict:
    root_is_real_directory = root.is_dir() and not root.is_symlink()
    raw = root / "raw"
    raw_is_real_directory = raw.is_dir() and not raw.is_symlink()
    intent = root / "creator-intent.txt"
    intent_is_real_file = intent.is_file() and not intent.is_symlink()
    top = sorted(path.name for path in root.iterdir()) if root_is_real_directory else []
    symlinks = sorted(path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_symlink()) if root_is_real_directory else []
    files = sorted(path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file() and not path.is_symlink()) if root_is_real_directory else []
    raw_files = [name for name in files if name.startswith("raw/")]
    source_json_files = [name for name in raw_files if name.lower().endswith(".json")]
    technical_config_files = [name for name in files if name != "creator-intent.txt" and not name.startswith("raw/")]
    return {
        "top_level": top,
        "files": files,
        "root_is_real_directory": root_is_real_directory,
        "raw_is_real_directory": raw_is_real_directory,
        "intent_is_real_file": intent_is_real_file,
        "symlinks": symlinks,
        "raw_file_count": len(raw_files),
        "source_json_files": source_json_files,
        "technical_config_files": technical_config_files,
        "raw_and_natural_language_intent_only": (
            set(top) == {"creator-intent.txt", "raw"}
            and root_is_real_directory
            and raw_is_real_directory
            and intent_is_real_file
            and not symlinks
            and bool(raw_files)
            and not technical_config_files
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--factory", type=Path, required=True)
    parser.add_argument("--release-a", type=Path, required=True)
    parser.add_argument("--release-b", type=Path, required=True)
    parser.add_argument("--raw-a", type=Path, required=True)
    parser.add_argument("--raw-b", type=Path, required=True)
    parser.add_argument("--forbidden", action="append", default=[])
    parser.add_argument("--forbidden-a", action="append", default=[])
    parser.add_argument("--forbidden-b", action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    releases = []
    for label, path in (("A", args.release_a.resolve()), ("B", args.release_b.resolve())):
        public = read(path / "public.json")
        private = read(path / "private.json")
        releases.append({
            "label": label,
            "path": str(path),
            "release_id": public["release_id"],
            "release_digest": public["digest"],
            "product_id": public["product_id"],
            "contract_version": public["contract_version"],
            "shape": release_shape(path, public["product_id"]),
            "content_hashes": {
                "public": sha(path / "public.json"),
                "private": sha(path / "private.json"),
                "rag_chunks": sha(path / private["rag"]["root"] / next(x["path"] for x in private["rag"]["documents"] if "chunk" in x["path"])),
            },
        })

    production_files = [
        *args.factory.glob("SKILL.md"),
        *args.factory.glob("README.md"),
        *args.factory.glob("scripts/*"),
        *args.factory.glob("references/*"),
        *args.factory.glob("agents/*"),
    ]
    scenario_hits = []
    for path in production_files:
        if not path.is_file() or path.suffix in {".pyc"}:
            continue
        text = path.read_text(errors="replace").lower()
        for term in [*args.forbidden, *args.forbidden_a, *args.forbidden_b]:
            pattern = rf"(?<![a-z0-9]){re.escape(term.lower())}(?![a-z0-9])"
            if re.search(pattern, text):
                scenario_hits.append({"file": str(path), "term": term})

    raw_a = raw_boundary(args.raw_a)
    raw_b = raw_boundary(args.raw_b)
    shape_isomorphic = releases[0]["shape"] == releases[1]["shape"]
    content_independent = all(
        releases[0]["content_hashes"][key] != releases[1]["content_hashes"][key]
        for key in releases[0]["content_hashes"]
    )
    scenario_probes_configured = len(args.forbidden_a) >= 2 and len(args.forbidden_b) >= 2
    checks = {
        "same_contract_version": releases[0]["contract_version"] == releases[1]["contract_version"],
        "release_shapes_are_isomorphic": shape_isomorphic,
        "release_content_is_independent": content_independent,
        "scenario_probe_covers_both_creator_domains": scenario_probes_configured,
        "factory_production_code_has_no_scenario_strings": scenario_probes_configured and not scenario_hits,
        "raw_a_requires_no_factory_config": raw_a["raw_and_natural_language_intent_only"],
        "raw_b_requires_no_factory_config": raw_b["raw_and_natural_language_intent_only"],
    }
    result = {
        "passed": all(checks.values()),
        "checks": checks,
        "releases": releases,
        "raw_inputs": {"A": raw_a, "B": raw_b},
        "scenario_string_hits": scenario_hits,
        "forbidden_terms": [*args.forbidden, *args.forbidden_a, *args.forbidden_b],
        "forbidden_term_groups": {"A": args.forbidden_a, "B": args.forbidden_b},
        "remaining_coupling": [],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"passed": result["passed"], "checks": checks}))
    if not result["passed"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
