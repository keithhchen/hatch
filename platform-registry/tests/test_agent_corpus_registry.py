import asyncio
import hashlib
import json
from pathlib import Path

import httpx

from hatch_registry.app import create_app
from hatch_registry.bailian_rag import BailianKnowledgeProvider
from hatch_registry.control_plane import ControlPlaneStore
from hatch_registry.corpus_resolver import AgentCorpusResolver
from hatch_registry.knowledge_binding import (
    AgentKnowledgeBinding,
    AgentKnowledgeBindingStore,
    KnowledgeSearchResult,
    UnavailableKnowledgeSearchProvider,
)
from hatch_registry.store import RegistryStore


TOKEN = "corpus-publish-test-token"


def request(app, method: str, url: str, **kwargs: object) -> httpx.Response:
    async def send() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, url, **kwargs)

    return asyncio.run(send())


def digest(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def asset(root: Path, identifier: str, relative_path: str, **extra: object) -> dict[str, object]:
    payload: dict[str, object] = {"id": identifier, "path": relative_path, "sha256": digest(root / relative_path)}
    payload.update(extra)
    return payload


def write_corpus(
    root: Path,
    *,
    with_creator_http_tool: bool = False,
    with_creator_mcp_tool: bool = False,
    include_skill: bool = True,
) -> None:
    (root / "instructions").mkdir(parents=True, exist_ok=True)
    (root / "knowledge").mkdir(parents=True, exist_ok=True)
    (root / "evals").mkdir(parents=True, exist_ok=True)
    (root / "instructions/system.md").write_text("Follow the creator method.\n", encoding="utf-8")
    (root / "knowledge/method.md").write_text("# Creator method\n\nPrioritize evidence before language.\n", encoding="utf-8")
    (root / "evals/synthetic-qa.json").write_text(json.dumps({
        "cases": [{"input": "Review this CV", "answer": "A bounded review."}],
    }), encoding="utf-8")
    (root / "evals/held-out.json").write_text(json.dumps({
        "cases": [{"input": "A fresh CV", "expected": "A bounded review."}],
    }), encoding="utf-8")

    tools: list[dict[str, object]] = [
        {"id": "hatch.web_search", "kind": "hatch_builtin", "capability": "web_search"},
        {"id": "hatch.file_search", "kind": "hatch_builtin", "capability": "file_search"},
    ]
    allowed_tool_ids = ["hatch.web_search", "hatch.file_search"]
    if with_creator_http_tool:
        tools.append({
            "id": "creator.market_data", "kind": "http_function", "connection_ref": "market-api",
            "operation": "get_market_snapshot", "description": "Get a market snapshot.",
            "input_schema": {"type": "object", "properties": {"ticker": {"type": "string"}}},
        })
        allowed_tool_ids.append("creator.market_data")
    if with_creator_mcp_tool:
        tools.append({
            "id": "creator.crm_lookup", "kind": "mcp_tool", "connection_ref": "creator-crm",
            "tool_name": "lookup_customer", "description": "Look up a customer.",
            "input_schema": {"type": "object", "properties": {"email": {"type": "string"}}},
        })
        allowed_tool_ids.append("creator.crm_lookup")

    skills: list[dict[str, object]] = []
    if include_skill:
        (root / "skills/resume-review/references").mkdir(parents=True, exist_ok=True)
        (root / "skills/resume-review/SKILL.md").write_text("# Review\n\nReview the supplied resume.\n", encoding="utf-8")
        (root / "skills/resume-review/references/evidence-method.md").write_text(
            "# Evidence method\n\nKeep the strongest evidence.\n", encoding="utf-8"
        )
        skills.append({
            "id": "resume-review", "name": "Resume review", "when_to_use": "When reviewing a resume.",
            "instruction": asset(root, "resume-review-instruction", "skills/resume-review/SKILL.md"),
            "references": [{
                "asset": asset(root, "resume-review-evidence-method", "skills/resume-review/references/evidence-method.md"),
                "kind": "method",
            }],
            "allowed_tool_ids": allowed_tool_ids,
        })

    agent = {
        "contract_version": "1",
        "agent_id": "resume-review",
        "creator": {"id": "maya", "name": "Maya"},
        "product": {
            "id": "resume-review", "name": "Resume Review", "description": "Review a resume.",
        },
        "instructions": {"system": asset(root, "system", "instructions/system.md")},
        "skills": skills,
        "knowledge": {"documents": [asset(
            root, "method", "knowledge/method.md", retrieval_only=True, title="Purified long-tail creator method."
        )]},
        "tools": tools,
        "evaluations": {
            "synthetic_qa": [asset(root, "synthetic-qa", "evals/synthetic-qa.json")],
            "held_out": [asset(root, "held-out", "evals/held-out.json")],
        },
    }
    (root / "agent.json").write_text(json.dumps(agent), encoding="utf-8")


class CapturingKnowledgeSearch:
    def __init__(self) -> None:
        self.bindings: list[AgentKnowledgeBinding] = []
        self.published: list[AgentKnowledgeBinding] = []

    def publish(self, *, binding: AgentKnowledgeBinding, corpus) -> None:
        self.published.append(binding)

    def search(
        self,
        *,
        binding: AgentKnowledgeBinding,
        query: str,
        max_num_results: int,
    ) -> list[KnowledgeSearchResult]:
        self.bindings.append(binding)
        return [KnowledgeSearchResult(
            text=f"Evidence for: {query}",
            metadata={"namespace": binding.namespace, "limit": max_num_results},
            score=0.92,
        )]


def configured_app(tmp_path: Path, *, knowledge_search: CapturingKnowledgeSearch | None = None):
    provider = knowledge_search or CapturingKnowledgeSearch()
    repo_root = Path(__file__).resolve().parents[2]
    resolver = AgentCorpusResolver(
        tmp_path / "registry-corpora",
        repo_root / "packages/protocol/schemas/creator-agent.schema.json",
    )
    return create_app(
        RegistryStore(
            corpus_resolver=resolver,
            knowledge_binding_store=AgentKnowledgeBindingStore(backend="bailian"),
            knowledge_provider=provider,
            state_path=tmp_path / "registry-state.json",
        ),
        publish_service_token=TOKEN,
        control_plane=ControlPlaneStore(tmp_path / "control-plane.sqlite3"),
        knowledge_search=provider,
    ), resolver


def headers(creator_id: str | None = None) -> dict[str, str]:
    values = {"authorization": f"Bearer {TOKEN}"}
    if creator_id:
        values["x-hatch-creator-id"] = creator_id
    return values


def test_registry_promotes_exact_current_corpus_and_exposes_rag_namespace(tmp_path: Path) -> None:
    source = tmp_path / "factory-output/agent-corpus"
    write_corpus(source)
    app, resolver = configured_app(tmp_path)

    response = request(app, "POST", "/v1/agent-corpora", json={"corpus_path": str(source)}, headers=headers())

    assert response.status_code == 201
    published = response.json()
    assert published["agent_id"] == "resume-review"
    assert "artifact_path" not in published
    assert published["rag"] == {"backend": "bailian", "namespace": "maya/resume-review"}
    assert published["product"] == {"id": "resume-review", "name": "Resume Review", "description": "Review a resume."}
    resolved = resolver.resolve("maya", "resume-review")
    assert resolved.corpus_digest == published["corpus_digest"]
    assert not (tmp_path / "registry-corpora/maya/resume-review/knowledge/index.json").exists()
    restarted, _ = configured_app(tmp_path)
    listed = request(restarted, "GET", "/v1/creators/maya/agent-corpora")
    assert listed.status_code == 200
    assert listed.json()[0]["corpus_digest"] == published["corpus_digest"]


def test_runtime_knowledge_endpoint_uses_only_current_agent_scoped_binding(tmp_path: Path) -> None:
    source = tmp_path / "factory-output/agent-corpus"
    write_corpus(source)
    provider = CapturingKnowledgeSearch()
    app, _ = configured_app(tmp_path, knowledge_search=provider)
    assert request(app, "POST", "/v1/agent-corpora", json={"corpus_path": str(source)}, headers=headers()).status_code == 201

    response = request(
        app,
        "POST",
        "/v1/runtime/creators/maya/agents/resume-review/knowledge/search",
        json={"query": "Which achievement should remain?", "max_num_results": 3},
        headers=headers(),
    )

    assert response.status_code == 200
    assert response.json() == {"data": [{
        "text": "Evidence for: Which achievement should remain?",
        "metadata": {"namespace": "maya/resume-review", "limit": 3},
        "score": 0.92,
    }]}
    assert len(provider.bindings) == 1
    binding = provider.bindings[0]
    assert binding.creator_id == "maya"
    assert binding.agent_id == "resume-review"
    assert binding.backend == "bailian"
    assert binding.namespace == "maya/resume-review"
    other_creator = request(
        app,
        "POST",
        "/v1/runtime/creators/other/agents/resume-review/knowledge/search",
        json={"query": "blocked"},
        headers=headers(),
    )
    assert other_creator.status_code == 404


def test_runtime_knowledge_endpoint_fails_closed_without_managed_rag(tmp_path: Path) -> None:
    source = tmp_path / "factory-output/agent-corpus"
    write_corpus(source)
    published_app, resolver = configured_app(tmp_path)
    assert request(published_app, "POST", "/v1/agent-corpora", json={"corpus_path": str(source)}, headers=headers()).status_code == 201
    unavailable = UnavailableKnowledgeSearchProvider()
    app = create_app(
        RegistryStore(
            corpus_resolver=resolver,
            knowledge_binding_store=AgentKnowledgeBindingStore(backend="bailian"),
            knowledge_provider=unavailable,
            state_path=tmp_path / "registry-state.json",
        ),
        publish_service_token=TOKEN,
        control_plane=ControlPlaneStore(tmp_path / "control-plane.sqlite3"),
        knowledge_search=unavailable,
    )
    response = request(
        app,
        "POST",
        "/v1/runtime/creators/maya/agents/resume-review/knowledge/search",
        json={"query": "a relevant fact"},
        headers=headers(),
    )
    assert response.status_code == 503


def test_bailian_provider_persists_only_private_agent_scoped_index_binding(tmp_path: Path) -> None:
    source = tmp_path / "factory-output/agent-corpus"
    write_corpus(source)
    repo_root = Path(__file__).resolve().parents[2]
    resolver = AgentCorpusResolver(
        tmp_path / "registry-corpora",
        repo_root / "packages/protocol/schemas/creator-agent.schema.json",
    )
    verified = resolver.verify(source)
    binding = AgentKnowledgeBindingStore(backend="bailian").bind(verified)

    class FakeBailianApi:
        def __init__(self) -> None:
            self.documents: list[Path] = []
            self.queries: list[tuple[str, str, int]] = []

        def create_index(self, *, namespace: str, documents: list[Path]) -> str:
            assert namespace == "maya/resume-review"
            self.documents = documents
            return "private-index-id"

        def retrieve(self, *, index_id: str, query: str, max_num_results: int) -> list[KnowledgeSearchResult]:
            self.queries.append((index_id, query, max_num_results))
            return [KnowledgeSearchResult(text="Creator evidence", metadata={"title": "Method"}, score=0.8)]

    api = FakeBailianApi()
    provider = BailianKnowledgeProvider(api=api, state_path=tmp_path / "private-rag-state.json")
    provider.publish(binding=binding, corpus=verified)

    assert api.documents == [source / "knowledge/method.md"]
    assert provider.search(binding=binding, query="keep which result", max_num_results=2) == [
        KnowledgeSearchResult(text="Creator evidence", metadata={"title": "Method"}, score=0.8)
    ]
    private_state = (tmp_path / "private-rag-state.json").read_text(encoding="utf-8")
    assert "private-index-id" in private_state
    assert "private-index-id" not in (source / "agent.json").read_text(encoding="utf-8")


def test_registry_replaces_current_corpus_for_same_creator_agent(tmp_path: Path) -> None:
    source = tmp_path / "factory-output/agent-corpus"
    write_corpus(source)
    app, resolver = configured_app(tmp_path)
    first = request(app, "POST", "/v1/agent-corpora", json={"corpus_path": str(source)}, headers=headers())
    assert first.status_code == 201

    system = source / "instructions/system.md"
    system.write_text("Follow the revised creator method.\n", encoding="utf-8")
    agent = json.loads((source / "agent.json").read_text(encoding="utf-8"))
    agent["instructions"]["system"]["sha256"] = digest(system)
    (source / "agent.json").write_text(json.dumps(agent), encoding="utf-8")
    second = request(app, "POST", "/v1/agent-corpora", json={"corpus_path": str(source)}, headers=headers())
    assert second.status_code == 201
    assert second.json()["corpus_digest"] != first.json()["corpus_digest"]
    assert resolver.resolve("maya", "resume-review").corpus_digest == second.json()["corpus_digest"]


def test_registry_rejects_bad_hash_and_non_corpus_files(tmp_path: Path) -> None:
    source = tmp_path / "factory-output/agent-corpus"
    write_corpus(source)
    app, _ = configured_app(tmp_path)
    (source / "private-factory-trace.md").write_text("must never publish", encoding="utf-8")
    trace = request(app, "POST", "/v1/agent-corpora", json={"corpus_path": str(source)}, headers=headers())
    assert trace.status_code == 422
    (source / "private-factory-trace.md").unlink()
    agent = json.loads((source / "agent.json").read_text(encoding="utf-8"))
    agent["instructions"]["system"]["sha256"] = f"sha256:{'0' * 64}"
    (source / "agent.json").write_text(json.dumps(agent), encoding="utf-8")
    bad_hash = request(app, "POST", "/v1/agent-corpora", json={"corpus_path": str(source)}, headers=headers())
    assert bad_hash.status_code == 422


def test_registry_allows_zero_skills(tmp_path: Path) -> None:
    source = tmp_path / "factory-output/agent-corpus"
    write_corpus(source, include_skill=False)
    app, _ = configured_app(tmp_path)
    response = request(app, "POST", "/v1/agent-corpora", json={"corpus_path": str(source)}, headers=headers())
    assert response.status_code == 201


def test_registry_rejects_runtime_scope_and_missing_file_search_from_corpus(tmp_path: Path) -> None:
    source = tmp_path / "factory-output/agent-corpus"
    write_corpus(source)
    app, _ = configured_app(tmp_path)
    agent = json.loads((source / "agent.json").read_text(encoding="utf-8"))

    agent["tenant_id"] = "must-not-live-in-corpus"
    (source / "agent.json").write_text(json.dumps(agent), encoding="utf-8")
    scoped = request(app, "POST", "/v1/agent-corpora", json={"corpus_path": str(source)}, headers=headers())
    assert scoped.status_code == 422

    agent.pop("tenant_id")
    agent["tools"] = [tool for tool in agent["tools"] if tool["id"] != "hatch.file_search"]
    (source / "agent.json").write_text(json.dumps(agent), encoding="utf-8")
    missing_file_search = request(app, "POST", "/v1/agent-corpora", json={"corpus_path": str(source)}, headers=headers())
    assert missing_file_search.status_code == 422


def test_control_plane_binds_declared_http_and_mcp_tools_without_credential_in_corpus(tmp_path: Path) -> None:
    source = tmp_path / "factory-output/agent-corpus"
    write_corpus(source, with_creator_http_tool=True, with_creator_mcp_tool=True)
    app, _ = configured_app(tmp_path)
    assert request(app, "POST", "/v1/agent-corpora", json={"corpus_path": str(source)}, headers=headers()).status_code == 201

    http_connection = request(app, "PUT", "/v1/control-plane/connections/market-api", json={
        "kind": "http", "secret_ref": "env:HATCH_MARKET_API_TOKEN",
        "config": {"url": "https://market.example.test/v1/snapshot"},
    }, headers=headers("maya"))
    assert http_connection.status_code == 200
    mcp_connection = request(app, "PUT", "/v1/control-plane/connections/creator-crm", json={
        "kind": "mcp", "secret_ref": "vault:creator-crm",
        "config": {"url": "https://crm.example.test/mcp"},
    }, headers=headers("maya"))
    assert mcp_connection.status_code == 200
    assert request(app, "PUT", "/v1/creators/maya/agents/resume-review/tools/creator.market_data", json={"connection_id": "market-api"}, headers=headers("maya")).status_code == 204
    assert request(app, "PUT", "/v1/creators/maya/agents/resume-review/tools/creator.crm_lookup", json={"connection_id": "creator-crm"}, headers=headers("maya")).status_code == 204
    resolved = request(app, "GET", "/v1/runtime/creators/maya/agents/resume-review/tools/creator.crm_lookup", headers=headers("maya"))
    assert resolved.status_code == 200
    assert resolved.json()["kind"] == "mcp"
    assert "HATCH_MARKET_API_TOKEN" not in resolved.text
    mismatch = request(app, "PUT", "/v1/creators/maya/agents/resume-review/tools/creator.market_data", json={"connection_id": "creator-crm"}, headers=headers("maya"))
    assert mismatch.status_code == 422
