from __future__ import annotations

import os
from pathlib import Path
import secrets
from typing import Annotated

from fastapi import FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from hatch_registry.corpus_resolver import AgentCorpusResolver, AgentCorpusVerificationError
from hatch_registry.bailian_rag import BailianKnowledgeProvider
from hatch_registry.control_plane import ControlPlaneError, ControlPlaneStore
from hatch_registry.knowledge_binding import (
    AgentKnowledgeBinding,
    AgentKnowledgeBindingStore,
    KnowledgePublicationProvider,
    KnowledgeSearchUnavailable,
    UnavailableKnowledgeSearchProvider,
)
from hatch_registry.models import (
    AgentCorpusPublishRequest,
    AgentToolBindingUpsertRequest,
    KnowledgeSearchRequest,
    KnowledgeSearchResult,
    KnowledgeSearchResponse,
    PublishedAgentCorpus,
    ResolvedToolConnection,
    ToolConnectionUpsertRequest,
)
from hatch_registry.store import RegistryStore


def create_app(
    store: RegistryStore | None = None,
    publish_service_token: str | None = None,
    control_plane: ControlPlaneStore | None = None,
    knowledge_search: KnowledgePublicationProvider | None = None,
) -> FastAPI:
    # The Registry is installed as a Python package in production, while the
    # Agent Corpus schema remains a release asset next to `platform-registry/`.
    # Resolve that release root from the service working directory instead of
    # from this module's site-packages location.
    repo_root = Path(os.environ.get("HATCH_REGISTRY_REPO_ROOT", Path.cwd().parent)).resolve()
    corpus_root = Path(os.environ.get("HATCH_AGENT_CORPUS_ROOT", repo_root / "agent-corpora"))
    rag_backend = os.environ.get("HATCH_RAG_BACKEND", "bailian")
    configured_state_path = os.environ.get("HATCH_REGISTRY_STATE_PATH", "").strip()
    state_path = Path(configured_state_path).expanduser() if configured_state_path else None
    configured_control_plane_path = os.environ.get("HATCH_CONTROL_PLANE_DB_PATH", "").strip()
    control_plane_path = Path(configured_control_plane_path).expanduser() if configured_control_plane_path else (repo_root / "control-plane.sqlite3")
    knowledge_search_provider = (
        knowledge_search
        or BailianKnowledgeProvider.from_environment()
        or UnavailableKnowledgeSearchProvider()
    )
    registry_store = store or RegistryStore(
        corpus_resolver=AgentCorpusResolver(
            corpus_root=corpus_root,
            schema_path=repo_root / "packages/protocol/schemas/creator-agent.schema.json",
        ),
        knowledge_binding_store=AgentKnowledgeBindingStore(backend=rag_backend),
        knowledge_provider=knowledge_search_provider,
        state_path=state_path,
    )
    control_plane_store = control_plane

    def get_control_plane_store() -> ControlPlaneStore:
        nonlocal control_plane_store
        if control_plane_store is None:
            control_plane_store = ControlPlaneStore(control_plane_path)
        return control_plane_store
    token_source = (
        os.environ.get("HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN", "")
        if publish_service_token is None
        else publish_service_token
    )
    configured_publish_service_token = token_source.strip()

    api = FastAPI(
        title="Hatch Creator Agent Registry",
        version="1.0.0",
        summary="Registry for the current runnable Creator Agent Corpus.",
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
        "/v1/agent-corpora",
        response_model=PublishedAgentCorpus,
        status_code=status.HTTP_201_CREATED,
    )
    def publish_agent_corpus(
        request: AgentCorpusPublishRequest,
        authorization: Annotated[str | None, Header()] = None,
        tenant_id: Annotated[str | None, Header(alias="X-Hatch-Tenant-Id")] = None,
    ) -> PublishedAgentCorpus:
        authenticated_tenant_id = require_internal_publish_auth(
            authorization,
            tenant_id,
            configured_publish_service_token,
        )
        try:
            return registry_store.publish_agent_corpus(request, tenant_id=authenticated_tenant_id)
        except AgentCorpusVerificationError as exc:
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
        "/v1/tenants/{tenant_id}/agent-corpora",
        response_model=list[PublishedAgentCorpus],
    )
    def list_agent_corpora(tenant_id: str) -> list[PublishedAgentCorpus]:
        return registry_store.list_agent_corpora(tenant_id)

    @api.get(
        "/v1/tenants/{tenant_id}/agent-corpora/{agent_id}",
        response_model=PublishedAgentCorpus,
    )
    def get_agent_corpus(tenant_id: str, agent_id: str) -> PublishedAgentCorpus:
        corpus = registry_store.get_agent_corpus(tenant_id, agent_id)
        if corpus is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Agent Corpus not found for tenant={tenant_id} agent={agent_id}",
            )
        return corpus

    @api.post(
        "/v1/runtime/tenants/{tenant_id}/agents/{agent_id}/knowledge/search",
        response_model=KnowledgeSearchResponse,
    )
    def search_agent_knowledge(
        tenant_id: str,
        agent_id: str,
        request: KnowledgeSearchRequest,
        authorization: Annotated[str | None, Header()] = None,
        authenticated_tenant_id: Annotated[str | None, Header(alias="X-Hatch-Tenant-Id")] = None,
    ) -> KnowledgeSearchResponse:
        tenant = require_internal_publish_auth(authorization, authenticated_tenant_id, configured_publish_service_token)
        if tenant != tenant_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant path does not match authenticated tenant")
        corpus = registry_store.get_agent_corpus(tenant_id, agent_id)
        if corpus is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent Corpus is not published")
        try:
            rows = knowledge_search_provider.search(
                binding=AgentKnowledgeBinding(
                    tenant_id=corpus.tenant_id,
                    agent_id=corpus.agent_id,
                    corpus_digest=corpus.corpus_digest,
                    backend=corpus.rag.backend,
                    namespace=corpus.rag.namespace,
                ),
                query=request.query,
                max_num_results=request.max_num_results,
            )
        except KnowledgeSearchUnavailable as exc:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
        return KnowledgeSearchResponse(data=[
            KnowledgeSearchResult(text=row.text, metadata=row.metadata, score=row.score)
            for row in rows
        ])

    @api.put("/v1/control-plane/connections/{connection_id}", response_model=ResolvedToolConnection)
    def upsert_tool_connection(
        connection_id: str,
        request: ToolConnectionUpsertRequest,
        authorization: Annotated[str | None, Header()] = None,
        tenant_id: Annotated[str | None, Header(alias="X-Hatch-Tenant-Id")] = None,
    ) -> ResolvedToolConnection:
        authenticated_tenant_id = require_internal_publish_auth(authorization, tenant_id, configured_publish_service_token)
        try:
            connection = get_control_plane_store().upsert_connection(
                tenant_id=authenticated_tenant_id,
                connection_id=connection_id,
                kind=request.kind,
                secret_ref=request.secret_ref,
                config=request.config,
                status=request.status,
            )
            return ResolvedToolConnection.model_validate(connection.__dict__)
        except ControlPlaneError as exc:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    @api.put("/v1/tenants/{tenant_id}/agents/{agent_id}/tools/{tool_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
    def bind_agent_tool(
        tenant_id: str,
        agent_id: str,
        tool_id: str,
        request: AgentToolBindingUpsertRequest,
        authorization: Annotated[str | None, Header()] = None,
        authenticated_tenant_id: Annotated[str | None, Header(alias="X-Hatch-Tenant-Id")] = None,
    ) -> None:
        tenant = require_internal_publish_auth(authorization, authenticated_tenant_id, configured_publish_service_token)
        if tenant != tenant_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant path does not match authenticated tenant")
        try:
            # This tenant-scoped lookup happens before the declared Corpus tool
            # is allowed to bind to a connection.
            raw_connection = get_control_plane_store().get_connection(tenant_id=tenant, connection_id=request.connection_id)
            registry_store.validate_agent_tool_binding(
                tenant_id=tenant,
                agent_id=agent_id,
                tool_id=tool_id,
                connection_ref=request.connection_id,
                kind=raw_connection.kind,
            )
            get_control_plane_store().bind_agent_tool(
                tenant_id=tenant,
                agent_id=agent_id,
                tool_id=tool_id,
                connection_id=request.connection_id,
            )
        except (ControlPlaneError, ValueError) as exc:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    @api.get("/v1/runtime/tenants/{tenant_id}/agents/{agent_id}/tools/{tool_id}", response_model=ResolvedToolConnection)
    def resolve_runtime_tool_connection(
        tenant_id: str,
        agent_id: str,
        tool_id: str,
        authorization: Annotated[str | None, Header()] = None,
        authenticated_tenant_id: Annotated[str | None, Header(alias="X-Hatch-Tenant-Id")] = None,
    ) -> ResolvedToolConnection:
        tenant = require_internal_publish_auth(authorization, authenticated_tenant_id, configured_publish_service_token)
        if tenant != tenant_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant path does not match authenticated tenant")
        try:
            connection = get_control_plane_store().resolve(tenant_id=tenant, agent_id=agent_id, tool_id=tool_id)
            return ResolvedToolConnection.model_validate(connection.__dict__)
        except ControlPlaneError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    return api


def require_internal_publish_auth(
    authorization: str | None,
    tenant_id: str | None,
    configured_service_token: str,
) -> str:
    if not configured_service_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Agent Corpus publishing is not configured.",
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
    normalized_tenant_id = (tenant_id or "").strip()
    if not normalized_tenant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-Hatch-Tenant-Id is required.",
        )
    return normalized_tenant_id


app = create_app()


def main() -> None:
    uvicorn.run("hatch_registry.app:app", host="127.0.0.1", port=8100, reload=False)
