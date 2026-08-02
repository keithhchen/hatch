from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class AgentCorpusPublishRequest(BaseModel):
    """Internal Factory-to-Registry handoff on the shared POSIX host."""

    corpus_path: str = Field(min_length=1)


class AgentProduct(BaseModel):
    """Commercial presentation belongs to the product layer, not the Corpus."""

    id: str
    name: str
    description: str | None = None


class PublishedAgentCorpus(BaseModel):
    """The public record for the one current Corpus of an Agent.

    This intentionally does not expose a filesystem path.  The POSIX artifact
    location is an implementation detail of the Registry resolver, while the
    digest is the identity a Runtime can use to audit what it materialized.
    """

    agent_id: str
    creator_id: str
    product: AgentProduct
    corpus_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    rag: "AgentRagBinding"
    status: Literal["published"]
    published_at: datetime


class AgentRagBinding(BaseModel):
    """An isolated retrieval namespace, not a vector-store implementation."""

    backend: str = Field(min_length=1)
    namespace: str = Field(pattern=r"^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*(?:/[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)?$")


class KnowledgeSearchRequest(BaseModel):
    query: str = Field(min_length=1)
    max_num_results: int = Field(default=5, ge=1, le=20)


class KnowledgeSearchResult(BaseModel):
    text: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    score: float | None = None


class KnowledgeSearchResponse(BaseModel):
    data: list[KnowledgeSearchResult]


class ToolConnectionUpsertRequest(BaseModel):
    kind: Literal["http", "mcp"]
    secret_ref: str | None = Field(default=None, min_length=1)
    config: dict[str, Any]
    status: Literal["active", "disabled"] = "active"


class AgentToolBindingUpsertRequest(BaseModel):
    connection_id: str = Field(min_length=1)


class ResolvedToolConnection(BaseModel):
    id: str
    creator_id: str
    kind: Literal["http", "mcp"]
    secret_ref: str | None
    config: dict[str, Any]
    status: Literal["active", "disabled"]
