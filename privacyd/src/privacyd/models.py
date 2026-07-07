from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SanitizeRequest(BaseModel):
    app_id: str = Field(min_length=1, max_length=128)
    text: str

    @field_validator("app_id")
    @classmethod
    def app_id_must_not_be_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("app_id must not be blank")
        return stripped


class SanitizedFindingModel(BaseModel):
    kind: str
    start: int
    end: int
    replacement: str
    pseudonym: str | None
    redacted: bool
    source: str
    confidence: float


class SanitizeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    app_id: str
    sanitized_text: str
    findings: list[SanitizedFindingModel]
