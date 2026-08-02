from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from hatch_registry.corpus_resolver import VerifiedAgentCorpus


@dataclass(frozen=True)
class AgentKnowledgeBinding:
    """The Registry's stable handoff to Hatch's managed retrieval service.

    A Corpus owns purified ``knowledge/`` documents.  It never owns an index
    id, an embedding model, a provider credential, or chunks.  Those are RAG
    infrastructure concerns.  This binding merely gives the RAG service one
    isolated namespace per Creator + Agent, which is the only identity Runtime
    needs for ``hatch.file_search``.
    """

    creator_id: str
    agent_id: str
    corpus_digest: str
    backend: str
    namespace: str


class AgentKnowledgeBindingStore:
    """Creates a deterministic, agent-scoped RAG binding without indexing text.

    Bailian integration belongs behind this boundary.  Its eventual IndexId is
    private service state; it must not be copied into the Agent Corpus or
    reconstructed from local lexical chunks.
    """

    def __init__(self, *, backend: str = "bailian") -> None:
        normalized_backend = backend.strip()
        if not normalized_backend:
            raise ValueError("RAG backend cannot be blank")
        self.backend = normalized_backend

    def bind(self, corpus: VerifiedAgentCorpus) -> AgentKnowledgeBinding:
        return AgentKnowledgeBinding(
            creator_id=corpus.creator_id,
            agent_id=corpus.agent_id,
            corpus_digest=corpus.corpus_digest,
            backend=self.backend,
            namespace=f"{corpus.creator_id}/{corpus.agent_id}",
        )


@dataclass(frozen=True)
class KnowledgeSearchResult:
    text: str
    metadata: dict[str, object]
    score: float | None = None


class KnowledgeSearchProvider(Protocol):
    """Private provider adapter used by the Registry, never by Runtime.

    A Bailian implementation resolves ``namespace`` to its IndexId in its own
    Control Plane state and authenticates with its own RAM credential.  Neither
    identifier nor credential crosses this interface to Runtime.
    """

    def search(
        self,
        *,
        binding: AgentKnowledgeBinding,
        query: str,
        max_num_results: int,
    ) -> list[KnowledgeSearchResult]: ...


class KnowledgePublicationProvider(KnowledgeSearchProvider, Protocol):
    """Provider-owned ingestion called before a Corpus becomes current.

    The Registry gives the provider only a verified clean Corpus and a scoped
    binding. The provider alone may retain its private IndexId mapping.
    """

    def publish(self, *, binding: AgentKnowledgeBinding, corpus: VerifiedAgentCorpus) -> None: ...


class KnowledgeSearchUnavailable(RuntimeError):
    pass


class UnavailableKnowledgeSearchProvider:
    """Safe default until the private managed-RAG adapter is configured."""

    def search(
        self,
        *,
        binding: AgentKnowledgeBinding,
        query: str,
        max_num_results: int,
    ) -> list[KnowledgeSearchResult]:
        raise KnowledgeSearchUnavailable(
            f"Managed RAG backend is not configured for {binding.creator_id}/{binding.agent_id}",
        )

    def publish(self, *, binding: AgentKnowledgeBinding, corpus: VerifiedAgentCorpus) -> None:
        documents = corpus.agent["knowledge"]["documents"]
        if documents:
            raise KnowledgeSearchUnavailable(
                f"Managed RAG backend is not configured for {binding.creator_id}/{binding.agent_id}",
            )
