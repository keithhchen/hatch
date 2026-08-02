from __future__ import annotations

import hashlib
import json
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from jsonschema import Draft202012Validator
from referencing import Registry, Resource


class AgentCorpusVerificationError(ValueError):
    pass


@dataclass(frozen=True)
class VerifiedAgentCorpus:
    agent_id: str
    creator_id: str
    product: dict[str, str | None]
    corpus_digest: str
    corpus_path: Path
    agent: dict[str, Any]


class AgentCorpusResolver:
    """Verify and atomically promote one current runtime-free Agent Corpus.

    This is deliberately a publication boundary, not a Factory or RAG engine.
    It accepts only the clean files explicitly declared by ``agent.json`` and
    rejects raw uploads, traces, extra drafts, symlinks, and stale artifacts.
    """

    def __init__(self, corpus_root: Path, schema_path: Path) -> None:
        self.corpus_root = corpus_root.resolve()
        self.schema_path = schema_path.resolve()
        try:
            schema = json.loads(self.schema_path.read_text(encoding="utf-8"))
            resources = Registry()
            for candidate in [schema, *_local_schema_references(self.schema_path, schema)]:
                identifier = candidate.get("$id") if isinstance(candidate, dict) else None
                if not isinstance(identifier, str) or not identifier:
                    raise ValueError("Agent schema resource is missing $id")
                resources = resources.with_resource(identifier, Resource.from_contents(candidate))
            self._validator = Draft202012Validator(schema, registry=resources)
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load Agent Corpus schema: {exc}") from exc

    def publish(self, source_path: Path) -> VerifiedAgentCorpus:
        source = source_path.resolve()
        verified = self.verify(source)
        target = self.corpus_root / verified.creator_id / verified.agent_id
        self._replace_current(source, target)
        return self.verify(target)

    def resolve(self, creator_id: str, agent_id: str) -> VerifiedAgentCorpus:
        return self.verify(self.corpus_root / creator_id / agent_id)

    def verify(self, corpus_path: Path) -> VerifiedAgentCorpus:
        root = corpus_path.resolve()
        if not root.is_dir():
            raise AgentCorpusVerificationError("Agent Corpus directory does not exist")

        agent = _read_object(root / "agent.json")
        errors = sorted(self._validator.iter_errors(agent), key=lambda error: list(error.path))
        if errors:
            detail = "; ".join(error.message for error in errors[:4])
            raise AgentCorpusVerificationError(f"Agent Corpus schema validation failed: {detail}")
        assets = list(_declared_assets(agent))
        _verify_assets(root, assets)
        actual = _corpus_files(root)
        expected = {"agent.json", *(asset["path"] for asset in assets)}
        if actual != expected:
            raise AgentCorpusVerificationError(
                "Agent Corpus assets do not match agent.json; "
                f"missing={sorted(expected - actual)} unexpected={sorted(actual - expected)}",
            )
        _verify_tool_references(agent)

        return VerifiedAgentCorpus(
            agent_id=agent["agent_id"],
            creator_id=agent["creator"]["id"],
            product={
                "id": agent["product"]["id"],
                "name": agent["product"]["name"],
                "description": agent["product"].get("description"),
            },
            corpus_digest=_tree_digest(root),
            corpus_path=root,
            agent=agent,
        )

    def _replace_current(self, source: Path, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        staged = target.parent / f".{target.name}.{uuid.uuid4().hex}.staged"
        backup = target.parent / f".{target.name}.{uuid.uuid4().hex}.previous"
        try:
            shutil.copytree(source, staged, symlinks=False)
            if target.exists():
                os.replace(target, backup)
            os.replace(staged, target)
        except OSError as exc:
            if backup.exists() and not target.exists():
                os.replace(backup, target)
            raise AgentCorpusVerificationError(f"cannot promote Agent Corpus: {exc}") from exc
        finally:
            if staged.exists():
                shutil.rmtree(staged)
            if backup.exists() and target.exists():
                shutil.rmtree(backup)


def _read_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise AgentCorpusVerificationError(f"Agent Corpus is missing {path.name}") from exc
    except json.JSONDecodeError as exc:
        raise AgentCorpusVerificationError(f"Agent Corpus has invalid JSON in {path.name}") from exc
    if not isinstance(value, dict):
        raise AgentCorpusVerificationError(f"Agent Corpus {path.name} must be an object")
    return value


def _declared_assets(agent: dict[str, Any]) -> Iterable[dict[str, Any]]:
    """Return every portable asset exactly once, across the Corpus layers."""

    yield agent["instructions"]["system"]
    for skill in agent.get("skills", []):
        yield skill["instruction"]
        for reference in skill.get("references", []):
            yield reference["asset"]
    for document in agent.get("knowledge", {}).get("documents", []):
        yield document
    for evaluation in agent["evaluations"]["synthetic_qa"]:
        yield evaluation
    for evaluation in agent["evaluations"]["held_out"]:
        yield evaluation


def _verify_assets(root: Path, assets: list[dict[str, Any]]) -> None:
    by_path: dict[str, dict[str, Any]] = {}
    ids: set[str] = set()
    for asset in assets:
        path = asset.get("path")
        identifier = asset.get("id")
        if not isinstance(path, str) or not isinstance(identifier, str):
            raise AgentCorpusVerificationError("Agent Corpus asset declaration is invalid")
        if path in by_path:
            raise AgentCorpusVerificationError(f"Agent Corpus repeats asset path: {path}")
        if identifier in ids:
            raise AgentCorpusVerificationError(f"Agent Corpus repeats asset id: {identifier}")
        by_path[path] = asset
        ids.add(identifier)

    for path, asset in by_path.items():
        candidate = root / path
        if not candidate.is_file() or candidate.is_symlink():
            raise AgentCorpusVerificationError(f"Agent Corpus asset is missing or unsafe: {path}")
        actual = f"sha256:{hashlib.sha256(candidate.read_bytes()).hexdigest()}"
        if actual != asset["sha256"]:
            raise AgentCorpusVerificationError(f"Agent Corpus asset digest does not match: {path}")
        if path.startswith("evals/"):
            _verify_json_asset(candidate, path)


def _verify_json_asset(path: Path, relative_path: str) -> None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AgentCorpusVerificationError(f"Agent Corpus evaluation is not valid JSON: {relative_path}") from exc
    if not isinstance(value, (dict, list)):
        raise AgentCorpusVerificationError(f"Agent Corpus evaluation must be JSON object or array: {relative_path}")


def _corpus_files(root: Path) -> set[str]:
    files: set[str] = set()
    for child in root.rglob("*"):
        if child.is_symlink():
            raise AgentCorpusVerificationError(f"Agent Corpus cannot contain symlinks: {child.relative_to(root)}")
        if child.is_file():
            files.add(child.relative_to(root).as_posix())
    return files


def _verify_tool_references(agent: dict[str, Any]) -> None:
    tools = agent["tools"]
    tool_ids = [tool["id"] for tool in tools]
    if len(tool_ids) != len(set(tool_ids)):
        raise AgentCorpusVerificationError("Agent Corpus repeats a tool id")
    known = set(tool_ids)
    for skill in agent.get("skills", []):
        unknown = set(skill.get("allowed_tool_ids", [])) - known
        if unknown:
            raise AgentCorpusVerificationError(f"Skill references unknown tool ids: {sorted(unknown)}")


def _tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for item in sorted(root.rglob("*"), key=lambda candidate: candidate.as_posix()):
        if item.is_file():
            digest.update(item.relative_to(root).as_posix().encode("utf-8"))
            digest.update(b"\0")
            digest.update(item.read_bytes())
    return f"sha256:{digest.hexdigest()}"


def _local_schema_references(schema_path: Path, schema: dict[str, Any]) -> list[dict[str, Any]]:
    """Load local schema references without allowing a remote schema fetch."""

    reference = schema.get("$ref")
    if not isinstance(reference, str) or "://" in reference or reference.startswith("#"):
        return []
    target = (schema_path.parent / reference).resolve()
    if target.parent != schema_path.parent or target.suffix != ".json":
        raise ValueError("Agent schema must reference a sibling JSON schema")
    value = json.loads(target.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("referenced Agent schema must be an object")
    return [value]
