from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


DEFAULT_SKILLS_ROOT = Path(__file__).parents[2] / "skills"


@dataclass(frozen=True)
class CreatorSkill:
    app_id: str
    name: str
    version: str
    description: str
    instructions: str
    allowed_tools: tuple[str, ...]
    manifest: dict[str, Any]


class SkillStore:
    def __init__(self, root: Path | None = None) -> None:
        self._root = root or Path(os.environ.get("HATCH_SKILLS_ROOT", DEFAULT_SKILLS_ROOT))

    @property
    def root(self) -> Path:
        return self._root

    def load(self, app_id: str) -> CreatorSkill:
        path = self._root / app_id / "SKILL.md"
        if not path.exists():
            raise LookupError(f"skill module not found for app_id={app_id}")

        frontmatter, instructions = parse_skill_md(path.read_text(encoding="utf-8"))
        metadata = frontmatter.get("metadata", {})
        hatch = metadata["hatch"]
        creator = hatch["creator"]
        runtime = hatch["runtime"]
        license_policy = hatch["license"]
        distribution = hatch["distribution"]
        permissions = hatch.get("permissions", [])
        allowed_tools = tuple(hatch.get("tools", []))

        manifest = {
            "app_id": hatch["app_id"],
            "name": frontmatter["name"],
            "version": hatch["version"],
            "description": frontmatter["description"],
            "creator": {
                "creator_id": creator["creator_id"],
                "display_name": creator["display_name"],
                "support_url": creator["support_url"],
            },
            "runtime": {
                "runtime_type": "remote_agent",
                "websocket_url": runtime["websocket_url"],
                "protocol_version": runtime["protocol_version"],
            },
            "permissions": permissions,
            "license": {
                "policy_id": license_policy["policy_id"],
                "plan": license_policy["plan"],
                "trial_days": int(license_policy["trial_days"]),
            },
            "distribution": {
                "channel": distribution["channel"],
                "install_size_bytes": int(distribution["install_size_bytes"]),
                "manifest_url": distribution["manifest_url"],
            },
        }

        return CreatorSkill(
            app_id=hatch["app_id"],
            name=frontmatter["name"],
            version=hatch["version"],
            description=frontmatter["description"],
            instructions=instructions,
            allowed_tools=allowed_tools,
            manifest=manifest,
        )


def parse_skill_md(source: str) -> tuple[dict[str, Any], str]:
    if not source.startswith("---\n"):
        raise ValueError("SKILL.md must start with YAML frontmatter")
    _, frontmatter_text, body = source.split("---", 2)
    frontmatter = yaml.safe_load(frontmatter_text) or {}
    if not frontmatter.get("name") or not frontmatter.get("description"):
        raise ValueError("SKILL.md frontmatter requires name and description")
    return frontmatter, body.strip()
