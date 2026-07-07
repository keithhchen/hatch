from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime

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
)
from hatch_registry.signing import ManifestSigner


class RegistryStore:
    def __init__(self, manifests: list[SignedManifest] | None = None) -> None:
        self._manifests: dict[str, list[SignedManifest]] = {}
        self._installs: dict[str, InstallRecord] = {}
        self._license_to_install_id: dict[str, str] = {}

        for manifest in manifests or []:
            app_versions = self._manifests.setdefault(manifest.manifest.app_id, [])
            app_versions.append(manifest)

        for app_versions in self._manifests.values():
            app_versions.sort(key=lambda signed: _version_key(signed.manifest.version))

    @classmethod
    def seeded(cls) -> "RegistryStore":
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
                websocket_url="ws://127.0.0.1:8200/runtime",
                protocol_version="0.1",
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
