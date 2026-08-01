from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


AppId = str


class CreatorProfile(BaseModel):
    creator_id: str = Field(..., examples=["creator_lorem"])
    display_name: str = Field(..., examples=["Lorem Creator"])
    support_url: str


class RuntimeSpec(BaseModel):
    runtime_type: Literal["remote_agent"]
    websocket_url: str
    protocol_version: str


class PermissionSpec(BaseModel):
    key: str
    description: str


class LicensePolicy(BaseModel):
    policy_id: str
    plan: Literal["trial", "subscription", "paid"]
    trial_days: int = Field(ge=0)


class DistributionSpec(BaseModel):
    channel: Literal["synthetic"]
    install_size_bytes: int = Field(ge=0)
    manifest_url: str


class AppManifest(BaseModel):
    app_id: AppId
    name: str
    version: str
    description: str
    creator: CreatorProfile
    runtime: RuntimeSpec
    permissions: list[PermissionSpec]
    license: LicensePolicy
    distribution: DistributionSpec


class ManifestSignature(BaseModel):
    algorithm: str
    key_id: str
    public_key: str
    signature: str


class SignedManifest(BaseModel):
    manifest: AppManifest
    signature: ManifestSignature


class ManifestSummary(BaseModel):
    app_id: AppId
    name: str
    latest_version: str
    description: str
    creator_display_name: str


class LatestVersionResponse(BaseModel):
    app_id: AppId
    version: str
    manifest_url: str
    signature: ManifestSignature


class InstallCreateRequest(BaseModel):
    app_id: AppId
    device_id: str = Field(min_length=3)
    version: str | None = None


class InstallRecord(BaseModel):
    install_id: str
    app_id: AppId
    version: str
    device_id: str
    status: Literal["installed"]
    sandbox_hint: str
    license_token: str
    created_at: datetime


class LicenseVerifyRequest(BaseModel):
    app_id: AppId
    license_token: str
    install_id: str | None = None


class LicenseVerificationResponse(BaseModel):
    app_id: AppId
    valid: bool
    status: Literal["active", "invalid"]
    install_id: str | None
    checked_at: datetime


class CreatorReleasePublishRequest(BaseModel):
    release_id: str = Field(min_length=3)
    release_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class PublishedCreatorRelease(BaseModel):
    creator_id: str
    product_id: str
    release_id: str
    release_digest: str
    name: str
    description: str
    promise: str
    price_minor: int
    currency: str
    pricing_model: Literal["per_delivery", "subscription"] | None = None
    supported_local_capabilities: list[str]
    version: str
    status: Literal["published"]
    published_at: datetime
