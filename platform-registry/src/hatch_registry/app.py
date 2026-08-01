from __future__ import annotations

import os
from pathlib import Path
import secrets
from typing import Annotated

from fastapi import FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from hatch_registry.models import CreatorReleasePublishRequest, PublishedCreatorRelease
from hatch_registry.release_resolver import ReleaseResolver, ReleaseVerificationError
from hatch_registry.store import RegistryStore


def create_app(
    store: RegistryStore | None = None,
    publish_service_token: str | None = None,
) -> FastAPI:
    default_root = Path(__file__).resolve().parents[3] / "runtime-releases"
    release_root = Path(os.environ.get("HATCH_CREATOR_RELEASE_ROOT", default_root))
    configured_state_path = os.environ.get("HATCH_REGISTRY_STATE_PATH", "").strip()
    state_path = Path(configured_state_path).expanduser() if configured_state_path else None
    registry_store = store or RegistryStore(
        release_resolver=ReleaseResolver(release_root),
        state_path=state_path,
    )
    token_source = (
        os.environ.get("HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN", "")
        if publish_service_token is None
        else publish_service_token
    )
    configured_publish_service_token = token_source.strip()

    api = FastAPI(
        title="Hatch Creator Release Registry",
        version="1.0.0",
        summary="Registry for verified, immutable Creator Agent Releases.",
    )
    api.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @api.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @api.post(
        "/v1/creator/releases",
        response_model=PublishedCreatorRelease,
        status_code=status.HTTP_201_CREATED,
    )
    def publish_creator_release(
        request: CreatorReleasePublishRequest,
        authorization: Annotated[str | None, Header()] = None,
        creator_id: Annotated[str | None, Header(alias="X-Hatch-Creator-Id")] = None,
    ) -> PublishedCreatorRelease:
        authenticated_creator_id = require_creator_publish_auth(
            authorization,
            creator_id,
            configured_publish_service_token,
        )
        try:
            return registry_store.publish_creator_release(
                request,
                creator_id=authenticated_creator_id,
            )
        except PermissionError as exc:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=str(exc),
            ) from exc
        except ReleaseVerificationError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=str(exc),
            ) from exc
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=str(exc),
            ) from exc

    @api.get(
        "/v1/creator/{creator_id}/releases",
        response_model=list[PublishedCreatorRelease],
    )
    def list_creator_releases(creator_id: str) -> list[PublishedCreatorRelease]:
        return registry_store.list_creator_releases(creator_id)

    @api.get(
        "/v1/creator-releases/{release_id:path}",
        response_model=PublishedCreatorRelease,
    )
    def get_creator_release(release_id: str) -> PublishedCreatorRelease:
        release = registry_store.get_creator_release(release_id)
        if release is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"creator release not found for release_id={release_id}",
            )
        return release

    return api


def require_creator_publish_auth(
    authorization: str | None,
    creator_id: str | None,
    configured_service_token: str,
) -> str:
    if not configured_service_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Creator Release publishing is not configured.",
        )
    scheme, _, supplied_token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not supplied_token or not secrets.compare_digest(
        supplied_token,
        configured_service_token,
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="A valid Registry publish service token is required.",
        )
    normalized_creator_id = (creator_id or "").strip()
    if not normalized_creator_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-Hatch-Creator-Id is required.",
        )
    return normalized_creator_id


app = create_app()


def main() -> None:
    uvicorn.run("hatch_registry.app:app", host="127.0.0.1", port=8100, reload=False)
