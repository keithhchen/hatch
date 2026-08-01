from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Mapping

from hatch_registry.models import CreatorReleasePublishRequest, PublishedCreatorRelease
from hatch_registry.release_resolver import ReleaseResolver


class RegistryStore:
    def __init__(
        self,
        release_resolver: ReleaseResolver | None = None,
        state_path: Path | None = None,
    ) -> None:
        self._release_resolver = release_resolver
        self._state_path = state_path
        self._creator_release_lock = threading.RLock()
        self._creator_releases = self._load_creator_releases()

    def publish_creator_release(
        self,
        request: CreatorReleasePublishRequest,
        *,
        creator_id: str,
    ) -> PublishedCreatorRelease:
        with self._creator_release_lock:
            existing = self._creator_releases.get(request.release_id)
            if existing is not None:
                if existing.creator_id != creator_id:
                    raise PermissionError(
                        f"release_id={request.release_id} belongs to another Creator",
                    )
                if existing.release_digest != request.release_digest:
                    raise ValueError(
                        f"release_id={request.release_id} is already pinned to a different digest",
                    )
                return existing
            if self._release_resolver is None:
                raise ValueError("Creator Release resolver is not configured")
            verified = self._release_resolver.resolve(request.release_id, request.release_digest)
            public = verified.public
            if public.get("creator_id") != creator_id:
                raise PermissionError(
                    f"release_id={request.release_id} does not belong to Creator {creator_id}",
                )
            product = public.get("product")
            if not isinstance(product, dict):
                raise ValueError("verified Creator Release is missing public product metadata")
            price = product.get("price")
            if not isinstance(price, dict):
                raise ValueError("verified Creator Release is missing public price")

            published = PublishedCreatorRelease(
                creator_id=str(public["creator_id"]),
                product_id=str(public["product_id"]),
                release_id=request.release_id,
                release_digest=request.release_digest,
                name=str(product["name"]),
                description=str(product["description"]),
                promise=str(product["promise"]),
                price_minor=int(price["amount_minor"]),
                currency=str(price["currency"]),
                pricing_model=price.get("model"),
                supported_local_capabilities=[
                    str(item) for item in product.get("supported_local_capabilities", [])
                ],
                version=str(public["version"]),
                status="published",
                published_at=datetime.now(UTC),
            )
            next_releases = {**self._creator_releases, request.release_id: published}
            self._persist_creator_releases(next_releases)
            self._creator_releases = next_releases
            return published

    def get_creator_release(self, release_id: str) -> PublishedCreatorRelease | None:
        return self._creator_releases.get(release_id)

    def list_creator_releases(self, creator_id: str) -> list[PublishedCreatorRelease]:
        return sorted(
            (
                release
                for release in self._creator_releases.values()
                if release.creator_id == creator_id
            ),
            key=lambda release: release.published_at,
            reverse=True,
        )

    def _load_creator_releases(self) -> dict[str, PublishedCreatorRelease]:
        if self._state_path is None or not self._state_path.exists():
            return {}
        try:
            payload = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"cannot load Registry state from {self._state_path}: {exc}") from exc
        if not isinstance(payload, dict) or payload.get("schema_version") != 1:
            raise ValueError(f"unsupported Registry state in {self._state_path}")
        serialized_releases = payload.get("creator_releases")
        if not isinstance(serialized_releases, list):
            raise ValueError(f"Registry state has invalid creator_releases in {self._state_path}")

        releases: dict[str, PublishedCreatorRelease] = {}
        for item in serialized_releases:
            try:
                release = PublishedCreatorRelease.model_validate(item)
            except (TypeError, ValueError) as exc:
                raise ValueError(
                    f"Registry state has an invalid Creator Release in {self._state_path}",
                ) from exc
            if release.release_id in releases:
                raise ValueError(
                    f"Registry state repeats release_id={release.release_id} in {self._state_path}",
                )
            releases[release.release_id] = release
        return releases

    def _persist_creator_releases(
        self,
        releases: Mapping[str, PublishedCreatorRelease],
    ) -> None:
        if self._state_path is None:
            return
        state_path = self._state_path
        state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": 1,
            "creator_releases": [
                release.model_dump(mode="json")
                for _, release in sorted(releases.items())
            ],
        }
        temporary_path = state_path.with_name(f".{state_path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary_path.open("x", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, state_path)
            directory_fd = os.open(state_path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            temporary_path.unlink(missing_ok=True)
