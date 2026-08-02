"""Private Alibaba Cloud Model Studio adapter for Hatch Agent knowledge.

This module intentionally sits behind the Registry. It uses Bailian only for
document parsing, embeddings and retrieval; Kimi remains the sole LLM used by
Factory and Runtime. Agent Corpus and Runtime never receive an IndexId, RAM
credential, presigned URL, or Bailian response metadata that could contain one.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.request import Request, urlopen

from hatch_registry.corpus_resolver import VerifiedAgentCorpus
from hatch_registry.knowledge_binding import (
    AgentKnowledgeBinding,
    KnowledgeSearchResult,
    KnowledgeSearchUnavailable,
)


class BailianKnowledgeApi(Protocol):
    """Small SDK-shaped surface so the provider can be unit-tested offline."""

    def create_index(self, *, namespace: str, documents: list[Path]) -> str: ...

    def retrieve(self, *, index_id: str, query: str, max_num_results: int) -> list[KnowledgeSearchResult]: ...


@dataclass(frozen=True)
class BailianRagConfiguration:
    workspace_id: str
    state_path: Path
    access_key_id: str | None = None
    access_key_secret: str | None = None
    category_id: str = "default"
    # `AUTO_SELECT` is an official parser value. The Factory has already
    # purified retrieval assets into Markdown; Model Studio selects the
    # category's supported parser without us inventing another document path.
    parser: str = "AUTO_SELECT"
    timeout_seconds: int = 900


class BailianKnowledgeProvider:
    """One current Bailian index binding per `creator_id/agent_id` namespace."""

    def __init__(self, *, api: BailianKnowledgeApi, state_path: Path) -> None:
        self._api = api
        self._state_path = state_path
        self._lock = threading.RLock()

    @classmethod
    def from_environment(cls, environment: dict[str, str] | os._Environ[str] = os.environ) -> "BailianKnowledgeProvider | None":
        workspace_id = environment.get("HATCH_BAILIAN_WORKSPACE_ID", "").strip()
        access_key_id = environment.get("ALIBABA_CLOUD_ACCESS_KEY_ID", "").strip()
        access_key_secret = environment.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET", "").strip()
        configured_state = environment.get("HATCH_BAILIAN_RAG_STATE_PATH", "").strip()
        if not workspace_id:
            return None
        if bool(access_key_id) != bool(access_key_secret):
            raise RuntimeError(
                "ALIBABA_CLOUD_ACCESS_KEY_ID and ALIBABA_CLOUD_ACCESS_KEY_SECRET "
                "must be configured together when using explicit Bailian credentials",
            )
        state_path = Path(configured_state).expanduser() if configured_state else Path("bailian-rag-state.json")
        config = BailianRagConfiguration(
            workspace_id=workspace_id,
            access_key_id=access_key_id,
            access_key_secret=access_key_secret,
            state_path=state_path,
            category_id=environment.get("HATCH_BAILIAN_CATEGORY_ID", "default").strip() or "default",
            parser=environment.get("HATCH_BAILIAN_PARSER", "AUTO_SELECT").strip() or "AUTO_SELECT",
        )
        return cls(api=BailianSdkKnowledgeApi(config), state_path=state_path)

    def publish(self, *, binding: AgentKnowledgeBinding, corpus: VerifiedAgentCorpus) -> None:
        documents = [
            corpus.corpus_path / item["path"]
            for item in corpus.agent["knowledge"]["documents"]
        ]
        # A space remains logically isolated even when there is nothing to
        # retrieve. Bailian itself cannot build an unstructured index with no
        # document, so map this current namespace to `null` rather than invent
        # a synthetic document.
        index_id = self._api.create_index(namespace=binding.namespace, documents=documents) if documents else None
        with self._lock:
            state = self._load_state()
            state[binding.namespace] = {
                "creator_id": binding.creator_id,
                "agent_id": binding.agent_id,
                "corpus_digest": binding.corpus_digest,
                "index_id": index_id,
            }
            self._save_state(state)

    def search(
        self,
        *,
        binding: AgentKnowledgeBinding,
        query: str,
        max_num_results: int,
    ) -> list[KnowledgeSearchResult]:
        with self._lock:
            record = self._load_state().get(binding.namespace)
        if not isinstance(record, dict):
            raise KnowledgeSearchUnavailable(f"No current Bailian RAG binding for {binding.namespace}")
        if record.get("creator_id") != binding.creator_id or record.get("agent_id") != binding.agent_id:
            raise KnowledgeSearchUnavailable(f"Invalid Bailian RAG scope for {binding.namespace}")
        if record.get("corpus_digest") != binding.corpus_digest:
            raise KnowledgeSearchUnavailable(f"Stale Bailian RAG binding for {binding.namespace}")
        index_id = record.get("index_id")
        if index_id is None:
            return []
        if not isinstance(index_id, str) or not index_id:
            raise KnowledgeSearchUnavailable(f"Invalid Bailian index binding for {binding.namespace}")
        return self._api.retrieve(index_id=index_id, query=query, max_num_results=max_num_results)

    def _load_state(self) -> dict[str, dict[str, object]]:
        if not self._state_path.exists():
            return {}
        try:
            payload = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise KnowledgeSearchUnavailable(f"Cannot load Bailian RAG state: {exc}") from exc
        if not isinstance(payload, dict) or payload.get("schema_version") != 1 or not isinstance(payload.get("namespaces"), dict):
            raise KnowledgeSearchUnavailable("Bailian RAG state has an unsupported schema")
        return payload["namespaces"]

    def _save_state(self, state: dict[str, dict[str, object]]) -> None:
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._state_path.with_name(f".{self._state_path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("x", encoding="utf-8") as output:
                json.dump({"schema_version": 1, "namespaces": state}, output, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self._state_path)
        finally:
            temporary.unlink(missing_ok=True)


class BailianSdkKnowledgeApi:
    """SDK adapter following Bailian's upload → parse → index → retrieve API."""

    def __init__(self, configuration: BailianRagConfiguration) -> None:
        self._configuration = configuration
        try:
            from alibabacloud_bailian20231229 import models as bailian_models
            from alibabacloud_bailian20231229.client import Client as BailianClient
            from alibabacloud_tea_openapi import models as open_api_models
            from alibabacloud_tea_util import models as util_models
        except ImportError as exc:  # pragma: no cover - deployment dependency gate
            raise RuntimeError("Bailian RAG requires the Alibaba Cloud Model Studio SDK dependencies") from exc
        self._models = bailian_models
        self._runtime_options = util_models.RuntimeOptions
        if configuration.access_key_id and configuration.access_key_secret:
            config = open_api_models.Config(
                access_key_id=configuration.access_key_id,
                access_key_secret=configuration.access_key_secret,
            )
        else:
            # Production Registry runs on the target ECS through an attached
            # RAM Role. The credentials SDK obtains and refreshes STS from
            # IMDS, so no developer-machine AccessKey is copied to the host.
            try:
                from alibabacloud_credentials.client import Client as CredentialsClient
                from alibabacloud_credentials.models import Config as CredentialsConfig
            except ImportError as exc:  # pragma: no cover - deployment dependency gate
                raise RuntimeError("Bailian RAG on ECS requires alibabacloud-credentials") from exc
            config = open_api_models.Config(
                credential=CredentialsClient(CredentialsConfig(type="ecs_ram_role")),
            )
        config.endpoint = "bailian.cn-beijing.aliyuncs.com"
        self._client = BailianClient(config)

    def create_index(self, *, namespace: str, documents: list[Path]) -> str:
        if not documents:
            raise ValueError("Bailian index creation requires at least one knowledge document")
        document_ids = [self._upload_and_wait(document) for document in documents]
        index_name = f"h-{hashlib.sha256(namespace.encode('utf-8')).hexdigest()[:16]}"
        request = self._models.CreateIndexRequest(
            structure_type="unstructured",
            name=index_name,
            source_type="DATA_CENTER_FILE",
            # Bailian's CreateIndex contract calls its managed vector store
            # `BUILT_IN`; `DEFAULT` is not a valid SinkType and would make the
            # first real Corpus publication fail after upload and parsing.
            sink_type="BUILT_IN",
            document_ids=document_ids,
        )
        response = self._client.create_index_with_options(
            self._configuration.workspace_id,
            request,
            {},
            self._runtime_options(),
        )
        index_id = _attribute(response.body.data, "id")
        if not isinstance(index_id, str) or not index_id:
            raise RuntimeError("Bailian CreateIndex returned no index id")
        submit = self._client.submit_index_job_with_options(
            self._configuration.workspace_id,
            self._models.SubmitIndexJobRequest(index_id=index_id),
            {},
            self._runtime_options(),
        )
        job_id = _attribute(submit.body.data, "id")
        if not isinstance(job_id, str) or not job_id:
            raise RuntimeError("Bailian SubmitIndexJob returned no job id")
        self._wait_index(index_id=index_id, job_id=job_id)
        return index_id

    def retrieve(self, *, index_id: str, query: str, max_num_results: int) -> list[KnowledgeSearchResult]:
        response = self._client.retrieve_with_options(
            self._configuration.workspace_id,
            self._models.RetrieveRequest(
                index_id=index_id,
                query=query,
                dense_similarity_top_k=max_num_results,
                enable_reranking=True,
            ),
            {},
            self._runtime_options(),
        )
        _raise_on_provider_error(response.body, "Bailian retrieve")
        nodes = _attribute(response.body.data, "nodes")
        if not isinstance(nodes, list):
            return []
        rows: list[KnowledgeSearchResult] = []
        for node in nodes[:max_num_results]:
            metadata_raw = _attribute(node, "metadata")
            metadata = _safe_metadata(metadata_raw)
            text = _attribute(node, "text")
            if (not isinstance(text, str) or not text.strip()) and isinstance(metadata_raw, dict):
                text = metadata_raw.get("content")
            if not isinstance(text, str) or not text.strip():
                continue
            score = _attribute(node, "score")
            rows.append(KnowledgeSearchResult(
                text=text,
                metadata=metadata,
                score=float(score) if isinstance(score, (int, float)) else None,
            ))
        return rows

    def _upload_and_wait(self, source: Path) -> str:
        payload = source.read_bytes()
        lease = self._client.apply_file_upload_lease_with_options(
            self._configuration.category_id,
            self._configuration.workspace_id,
            self._models.ApplyFileUploadLeaseRequest(
                file_name=source.name,
                md_5=hashlib.md5(payload).hexdigest(),
                size_in_bytes=str(len(payload)),
            ),
            {},
            self._runtime_options(),
        )
        data = lease.body.data
        lease_id = _attribute(data, "file_upload_lease_id")
        params = _attribute(data, "param")
        upload_url = _attribute(params, "url")
        upload_headers = _attribute(params, "headers")
        if not isinstance(lease_id, str) or not isinstance(upload_url, str) or not isinstance(upload_headers, dict):
            raise RuntimeError("Bailian upload lease response is incomplete")
        request = Request(
            upload_url,
            data=payload,
            method="PUT",
            headers={
                "X-bailian-extra": str(upload_headers["X-bailian-extra"]),
                "Content-Type": str(upload_headers["Content-Type"]),
            },
        )
        with urlopen(request, timeout=60) as response:  # nosec B310: signed URL from Bailian SDK
            if response.status not in {200, 201, 204}:
                raise RuntimeError(f"Bailian object upload failed with HTTP {response.status}")
        added = self._client.add_file_with_options(
            self._configuration.workspace_id,
            self._models.AddFileRequest(
                lease_id=lease_id,
                parser=self._configuration.parser,
                category_id=self._configuration.category_id,
            ),
            {},
            self._runtime_options(),
        )
        file_id = _attribute(added.body.data, "file_id")
        if not isinstance(file_id, str) or not file_id:
            raise RuntimeError("Bailian AddFile returned no file id")
        deadline = time.monotonic() + self._configuration.timeout_seconds
        while time.monotonic() < deadline:
            described = self._client.describe_file_with_options(
                self._configuration.workspace_id,
                file_id,
                self._models.DescribeFileRequest(),
                {},
                self._runtime_options(),
            )
            status = _attribute(described.body.data, "status")
            if status == "PARSE_SUCCESS":
                return file_id
            if status in {"INIT", "PARSING"}:
                time.sleep(2)
                continue
            raise RuntimeError(f"Bailian file parsing failed for {source.name}: {status}")
        raise RuntimeError(f"Bailian file parsing timed out for {source.name}")

    def _wait_index(self, *, index_id: str, job_id: str) -> None:
        deadline = time.monotonic() + self._configuration.timeout_seconds
        while time.monotonic() < deadline:
            result = self._client.get_index_job_status_with_options(
                self._configuration.workspace_id,
                self._models.GetIndexJobStatusRequest(index_id=index_id, job_id=job_id),
                {},
                self._runtime_options(),
            )
            status = _attribute(result.body.data, "status")
            if status == "COMPLETED":
                return
            if status in {"INIT", "RUNNING", "PENDING", "PROCESSING"}:
                time.sleep(2)
                continue
            raise RuntimeError(f"Bailian index build failed for {index_id}: {status}")
        raise RuntimeError(f"Bailian index build timed out for {index_id}")


def _attribute(value: object, name: str) -> Any:
    if isinstance(value, dict):
        return value.get(name) or value.get("".join(piece.title() for piece in name.split("_")))
    return getattr(value, name, None)


def _raise_on_provider_error(body: object, operation: str) -> None:
    """Do not turn a provider-level failure into a successful empty search."""
    success = _attribute(body, "success")
    code = _attribute(body, "code")
    message = _attribute(body, "message")
    if success is False or (isinstance(code, str) and code.startswith("Index.")):
        detail = ": ".join(str(value) for value in (code, message) if value)
        raise KnowledgeSearchUnavailable(f"{operation} unavailable{f': {detail}' if detail else ''}")


def _safe_metadata(value: object) -> dict[str, object]:
    raw = value if isinstance(value, dict) else {}
    allowed = ("doc_id", "doc_name", "title", "hier_title")
    return {key: raw[key] for key in allowed if isinstance(raw.get(key), (str, int, float, bool))}
