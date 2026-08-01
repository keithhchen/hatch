from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Mapping

from hatch_registry.corpus_resolver import AgentCorpusResolver
from hatch_registry.knowledge_binding import AgentKnowledgeBindingStore, KnowledgePublicationProvider
from hatch_registry.models import AgentCorpusPublishRequest, AgentRagBinding, PublishedAgentCorpus


class RegistryStore:
    """The Registry owns one current, runnable Agent Corpus per tenant+agent."""

    def __init__(
        self,
        corpus_resolver: AgentCorpusResolver | None = None,
        knowledge_binding_store: AgentKnowledgeBindingStore | None = None,
        knowledge_provider: KnowledgePublicationProvider | None = None,
        state_path: Path | None = None,
    ) -> None:
        self._corpus_resolver = corpus_resolver
        self._knowledge_binding_store = knowledge_binding_store
        self._knowledge_provider = knowledge_provider
        self._state_path = state_path
        self._lock = threading.RLock()
        self._agent_corpora = self._load_agent_corpora()

    def publish_agent_corpus(
        self,
        request: AgentCorpusPublishRequest,
        *,
        tenant_id: str,
    ) -> PublishedAgentCorpus:
        if self._corpus_resolver is None:
            raise ValueError("Agent Corpus resolver is not configured")
        if self._knowledge_binding_store is None:
            raise ValueError("Agent knowledge binding store is not configured")
        # Verify and index the clean source before switching the one current
        # Registry pointer. A failed upload therefore never replaces a working
        # Agent with a Corpus whose RAG space is missing or stale.
        source = self._corpus_resolver.verify(Path(request.corpus_path), tenant_id)
        rag_binding = self._knowledge_binding_store.bind(source)
        if self._knowledge_provider is None:
            raise ValueError("Agent knowledge provider is not configured")
        self._knowledge_provider.publish(binding=rag_binding, corpus=source)
        verified = self._corpus_resolver.publish(Path(request.corpus_path), tenant_id)
        key = f"{verified.tenant_id}:{verified.agent_id}"
        published = PublishedAgentCorpus(
            tenant_id=verified.tenant_id,
            agent_id=verified.agent_id,
            creator_id=verified.creator_id,
            product_id=verified.product_id,
            corpus_digest=verified.corpus_digest,
            rag=AgentRagBinding(
                backend=rag_binding.backend,
                namespace=rag_binding.namespace,
            ),
            status="published",
            published_at=datetime.now(UTC),
        )
        with self._lock:
            next_corpora = {**self._agent_corpora, key: published}
            self._persist_agent_corpora(next_corpora)
            self._agent_corpora = next_corpora
        return published

    def get_agent_corpus(self, tenant_id: str, agent_id: str) -> PublishedAgentCorpus | None:
        return self._agent_corpora.get(f"{tenant_id}:{agent_id}")

    def list_agent_corpora(self, tenant_id: str) -> list[PublishedAgentCorpus]:
        return sorted(
            (corpus for corpus in self._agent_corpora.values() if corpus.tenant_id == tenant_id),
            key=lambda corpus: corpus.published_at,
            reverse=True,
        )

    def validate_agent_tool_binding(
        self,
        *,
        tenant_id: str,
        agent_id: str,
        tool_id: str,
        connection_ref: str,
        kind: str,
    ) -> None:
        if self._corpus_resolver is None:
            raise ValueError("Agent Corpus resolver is not configured")
        corpus = self._corpus_resolver.resolve(tenant_id, agent_id)
        tools = corpus.agent.get("tools")
        if not isinstance(tools, list):
            raise ValueError("Agent Corpus has invalid tool declarations")
        declared = next((tool for tool in tools if isinstance(tool, dict) and tool.get("id") == tool_id), None)
        if declared is None:
            raise ValueError(f"Agent Corpus does not declare tool_id={tool_id}")
        expected_connection_kind = {
            "http_function": "http",
            "mcp_tool": "mcp",
        }.get(declared.get("kind"))
        if expected_connection_kind is None or expected_connection_kind != kind:
            raise ValueError(f"Agent Corpus tool {tool_id} does not match Control Plane kind={kind}")
        if declared.get("connection_ref") != connection_ref:
            raise ValueError(f"Agent Corpus tool {tool_id} does not match connection_ref={connection_ref}")

    def _load_agent_corpora(self) -> dict[str, PublishedAgentCorpus]:
        if self._state_path is None or not self._state_path.exists():
            return {}
        try:
            payload = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"cannot load Registry state from {self._state_path}: {exc}") from exc
        if not isinstance(payload, dict) or payload.get("schema_version") != 2:
            raise ValueError(f"unsupported Agent Corpus state in {self._state_path}")
        serialized = payload.get("agent_corpora")
        if not isinstance(serialized, list):
            raise ValueError(f"Agent Corpus state has invalid agent_corpora in {self._state_path}")
        records: dict[str, PublishedAgentCorpus] = {}
        for item in serialized:
            corpus = PublishedAgentCorpus.model_validate(item)
            key = f"{corpus.tenant_id}:{corpus.agent_id}"
            if key in records:
                raise ValueError(f"Agent Corpus state repeats {key} in {self._state_path}")
            records[key] = corpus
        return records

    def _persist_agent_corpora(self, corpora: Mapping[str, PublishedAgentCorpus]) -> None:
        if self._state_path is None:
            return
        state_path = self._state_path
        state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": 2,
            "agent_corpora": [corpus.model_dump(mode="json") for _, corpus in sorted(corpora.items())],
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
