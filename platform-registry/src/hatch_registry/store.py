from __future__ import annotations

import json
import os
import secrets
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Mapping

from hatch_registry.models import (
    AppManifest,
    CreatorProfile,
    DistributionSpec,
    InstallCreateRequest,
    InstallRecord,
    LatestVersionResponse,
    LicensePolicy,
    LicenseVerificationResponse,
    LicenseVerifyRequest,
    ManifestSummary,
    PermissionSpec,
    RuntimeSpec,
    SignedManifest,
    CreatorReleasePublishRequest,
    PublishedCreatorRelease,
)
from hatch_registry.signing import ManifestSigner
from hatch_registry.release_resolver import ReleaseResolver


class RegistryStore:
    def __init__(
        self,
        manifests: list[SignedManifest] | None = None,
        release_resolver: ReleaseResolver | None = None,
        state_path: Path | None = None,
    ) -> None:
        self._manifests: dict[str, list[SignedManifest]] = {}
        self._installs: dict[str, InstallRecord] = {}
        self._license_to_install_id: dict[str, str] = {}
        self._creator_releases: dict[str, PublishedCreatorRelease] = {}
        self._release_resolver = release_resolver
        self._state_path = state_path
        self._creator_release_lock = threading.RLock()

        for manifest in manifests or []:
            app_versions = self._manifests.setdefault(manifest.manifest.app_id, [])
            app_versions.append(manifest)

        for app_versions in self._manifests.values():
            app_versions.sort(key=lambda signed: _version_key(signed.manifest.version))

        self._creator_releases = self._load_creator_releases()

    @classmethod
    def seeded(
        cls,
        release_resolver: ReleaseResolver | None = None,
        state_path: Path | None = None,
    ) -> "RegistryStore":
        manifest = AppManifest(
            app_id="app_lorem_creator",
            name="Lorem Creator App",
            version="0.1.0",
            description="Synthetic skill-app that searches and edits the user's local lorem workspace.",
            creator=CreatorProfile(
                creator_id="creator_lorem",
                display_name="Lorem Creator",
                support_url="https://support.example.invalid/lorem",
            ),
            runtime=RuntimeSpec(
                runtime_type="remote_agent",
                websocket_url="ws://127.0.0.1:8400/runtime",
                protocol_version="0.3",
            ),
            permissions=[
                PermissionSpec(
                    key="workspace.read",
                    description="Read synthetic files inside the app sandbox.",
                ),
                PermissionSpec(
                    key="workspace.write",
                    description="Write synthetic outputs inside the app sandbox.",
                ),
            ],
            license=LicensePolicy(
                policy_id="license_lorem_subscription",
                plan="subscription",
                trial_days=0,
            ),
            distribution=DistributionSpec(
                channel="synthetic",
                install_size_bytes=4096,
                manifest_url="/v1/manifests/app_lorem_creator",
            ),
        )
        signer = ManifestSigner.development()
        return cls(
            manifests=[
                SignedManifest(manifest=manifest, signature=signer.sign(manifest)),
            ],
            release_resolver=release_resolver,
            state_path=state_path,
        )

    def has_app(self, app_id: str) -> bool:
        return app_id in self._manifests

    def list_manifest_summaries(self) -> list[ManifestSummary]:
        summaries = []
        for app_id in sorted(self._manifests):
            latest = self._latest_manifest_for(app_id)
            summaries.append(
                ManifestSummary(
                    app_id=latest.manifest.app_id,
                    name=latest.manifest.name,
                    latest_version=latest.manifest.version,
                    description=latest.manifest.description,
                    creator_display_name=latest.manifest.creator.display_name,
                ),
            )
        return summaries

    def get_latest_manifest(self, app_id: str) -> SignedManifest | None:
        if app_id not in self._manifests:
            return None
        return self._latest_manifest_for(app_id)

    def get_latest_version(self, app_id: str) -> LatestVersionResponse | None:
        latest = self.get_latest_manifest(app_id)
        if latest is None:
            return None
        return LatestVersionResponse(
            app_id=latest.manifest.app_id,
            version=latest.manifest.version,
            manifest_url=latest.manifest.distribution.manifest_url,
            signature=latest.signature,
        )

    def submit_manifest(self, manifest: AppManifest) -> SignedManifest:
        signer = ManifestSigner.development()
        signed_manifest = SignedManifest(manifest=manifest, signature=signer.sign(manifest))
        app_versions = self._manifests.setdefault(manifest.app_id, [])

        for index, existing in enumerate(app_versions):
            if existing.manifest.version == manifest.version:
                app_versions[index] = signed_manifest
                break
        else:
            app_versions.append(signed_manifest)

        app_versions.sort(key=lambda signed: _version_key(signed.manifest.version))
        return signed_manifest

    def create_install(self, request: InstallCreateRequest) -> InstallRecord:
        signed_manifest = self._get_manifest_for_install(request.app_id, request.version)
        install_id = f"inst_{uuid.uuid4().hex}"
        license_token = f"lic_{secrets.token_urlsafe(24)}"
        record = InstallRecord(
            install_id=install_id,
            app_id=signed_manifest.manifest.app_id,
            version=signed_manifest.manifest.version,
            device_id=request.device_id,
            status="installed",
            sandbox_hint=f"apps/{signed_manifest.manifest.app_id}",
            license_token=license_token,
            created_at=datetime.now(UTC),
        )
        self._installs[install_id] = record
        self._license_to_install_id[license_token] = install_id
        return record

    def verify_license(
        self,
        request: LicenseVerifyRequest,
    ) -> LicenseVerificationResponse:
        install_id = self._license_to_install_id.get(request.license_token)
        install = self._installs.get(install_id) if install_id else None

        valid = (
            install is not None
            and install.app_id == request.app_id
            and (request.install_id is None or request.install_id == install.install_id)
        )

        return LicenseVerificationResponse(
            app_id=request.app_id,
            valid=valid,
            status="active" if valid else "invalid",
            install_id=install.install_id if valid and install else None,
            checked_at=datetime.now(UTC),
        )

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

    def _latest_manifest_for(self, app_id: str) -> SignedManifest:
        return self._manifests[app_id][-1]

    def _get_manifest_for_install(
        self,
        app_id: str,
        version: str | None,
    ) -> SignedManifest:
        app_versions = self._manifests.get(app_id)
        if not app_versions:
            raise LookupError(f"app not found for app_id={app_id}")
        if version is None:
            return app_versions[-1]
        for signed_manifest in app_versions:
            if signed_manifest.manifest.version == version:
                return signed_manifest
        raise LookupError(f"version not found for app_id={app_id} version={version}")


def _version_key(version: str) -> tuple[int, ...]:
    parts: list[int] = []
    for part in version.split("."):
        if not part.isdigit():
            return (0,)
        parts.append(int(part))
    return tuple(parts)
