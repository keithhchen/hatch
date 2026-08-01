from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


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
