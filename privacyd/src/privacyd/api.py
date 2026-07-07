from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .entity_map import EntityMapper
from .models import SanitizeRequest, SanitizeResponse, SanitizedFindingModel
from .privacy_filter import NullPrivacyFilterAdapter, PrivacyFilterAdapter
from .sanitizer import sanitize_text


class PrivacyService:
    def __init__(
        self,
        *,
        entity_mapper: EntityMapper | None = None,
        privacy_filter: PrivacyFilterAdapter | None = None,
    ) -> None:
        self.entity_mapper = entity_mapper or EntityMapper()
        self.privacy_filter = privacy_filter or NullPrivacyFilterAdapter()

    def sanitize(self, request: SanitizeRequest) -> SanitizeResponse:
        result = sanitize_text(
            request.text,
            app_id=request.app_id,
            entity_mapper=self.entity_mapper,
            privacy_filter=self.privacy_filter,
        )
        return SanitizeResponse(
            app_id=result.app_id,
            sanitized_text=result.sanitized_text,
            findings=[
                SanitizedFindingModel(
                    kind=finding.kind,
                    start=finding.start,
                    end=finding.end,
                    replacement=finding.replacement,
                    pseudonym=finding.pseudonym,
                    redacted=finding.redacted,
                    source=finding.source,
                    confidence=finding.confidence,
                )
                for finding in result.findings
            ],
        )


def create_app(service: PrivacyService | None = None) -> FastAPI:
    app = FastAPI(title="Hatch privacyd", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.privacy_service = service or PrivacyService()

    @app.post("/sanitize", response_model=SanitizeResponse)
    def sanitize_endpoint(request: SanitizeRequest) -> SanitizeResponse:
        return app.state.privacy_service.sanitize(request)

    return app


app = create_app()
