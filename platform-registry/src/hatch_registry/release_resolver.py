from __future__ import annotations

import hashlib
import json
from pathlib import Path


class ReleaseVerificationError(ValueError):
    pass


class VerifiedRelease:
    def __init__(self, public: dict[str, object], release_path: Path) -> None:
        self.public = public
        self.release_path = release_path


class ReleaseResolver:
    def __init__(self, release_root: Path) -> None:
        self.release_root = release_root.resolve()

    def resolve(self, release_id: str, release_digest: str) -> VerifiedRelease:
        release_path = (self.release_root / release_id / release_digest).resolve()
        if not release_path.is_relative_to(self.release_root):
            raise ReleaseVerificationError("release identity escapes configured release root")
        public = _read_json(release_path / "public.json")
        private = _read_json(release_path / "private.json")

        _require_identity(public, private, release_id, release_digest, release_path)
        computed = _release_digest(public, private)
        if computed != release_digest:
            raise ReleaseVerificationError(
                f"release digest mismatch: expected {release_digest}, computed {computed}",
            )
        self._verify_assets(release_path, private)
        return VerifiedRelease(public=public, release_path=release_path)

    def _verify_assets(self, release_path: Path, private: dict[str, object]) -> None:
        asset_groups = [
            (private.get("protected_skills"), "assets"),
            (private.get("rag"), "documents"),
        ]
        for group, collection_key in asset_groups:
            if not isinstance(group, dict):
                raise ReleaseVerificationError(f"private.json is missing {collection_key}")
            root_name = group.get("root")
            assets = group.get(collection_key)
            if not isinstance(root_name, str) or not isinstance(assets, list):
                raise ReleaseVerificationError(f"invalid private asset group {collection_key}")
            asset_root = (release_path / root_name).resolve()
            if not asset_root.is_relative_to(release_path):
                raise ReleaseVerificationError("private asset root escapes Release")
            for asset in assets:
                if not isinstance(asset, dict):
                    raise ReleaseVerificationError("invalid private asset descriptor")
                relative = asset.get("path")
                expected = asset.get("sha256")
                if not isinstance(relative, str) or not isinstance(expected, str):
                    raise ReleaseVerificationError("private asset descriptor is incomplete")
                asset_path = (asset_root / relative).resolve()
                if not asset_path.is_relative_to(asset_root) or not asset_path.is_file():
                    raise ReleaseVerificationError(f"private asset is missing or escapes root: {relative}")
                actual = f"sha256:{hashlib.sha256(asset_path.read_bytes()).hexdigest()}"
                if actual != expected:
                    raise ReleaseVerificationError(f"private asset digest mismatch: {relative}")


def _read_json(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ReleaseVerificationError(f"Release file not found: {path.name}") from exc
    if not isinstance(value, dict):
        raise ReleaseVerificationError(f"Release file must be an object: {path.name}")
    return value


def _require_identity(
    public: dict[str, object],
    private: dict[str, object],
    release_id: str,
    release_digest: str,
    release_path: Path,
) -> None:
    if public.get("contract_version") != "1" or private.get("contract_version") != "1":
        raise ReleaseVerificationError("unsupported Creator Release contract version")
    if public.get("release_id") != release_id or private.get("release_id") != release_id:
        raise ReleaseVerificationError("Release files do not match requested release_id")
    if public.get("digest") != release_digest or private.get("digest") != release_digest:
        raise ReleaseVerificationError("Release files do not match requested digest")
    if release_path.parent.name != release_id or release_path.name != release_digest:
        raise ReleaseVerificationError("Release path does not match Release identity")
    for key in ("creator_id", "product_id", "version"):
        if not public.get(key) or public.get(key) != private.get(key):
            raise ReleaseVerificationError(f"public/private identity mismatch for {key}")


def _release_digest(public: dict[str, object], private: dict[str, object]) -> str:
    public_base = {key: value for key, value in public.items() if key != "digest"}
    private_base = {key: value for key, value in private.items() if key != "digest"}
    canonical = json.dumps(
        {"private": private_base, "public": public_base},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(canonical).hexdigest()}"
