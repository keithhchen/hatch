from pathlib import Path

from fastapi.testclient import TestClient

from hatch_registry.app import create_app
from hatch_registry.release_resolver import ReleaseResolver
from hatch_registry.store import RegistryStore

PUBLISH_SERVICE_TOKEN = "registry-publish-test-token"


def release_root() -> Path:
    return (
        Path(__file__).resolve().parents[2]
        / "docs/proof/creator-factory-e2e-v1/release"
    )


def make_client(
    publish_service_token: str = PUBLISH_SERVICE_TOKEN,
    *,
    state_path: Path | None = None,
) -> TestClient:
    return TestClient(create_app(
        RegistryStore(ReleaseResolver(release_root()), state_path=state_path),
        publish_service_token=publish_service_token,
    ))


def creator_publish_headers(creator_id: str = "maya-chen") -> dict[str, str]:
    return {
        "authorization": f"Bearer {PUBLISH_SERVICE_TOKEN}",
        "x-hatch-creator-id": creator_id,
    }


def test_creator_publish_pins_exact_release_identity_and_is_idempotent() -> None:
    client = make_client()
    request = {
        "release_id": "signal-resume-review@1.0.0",
        "release_digest": "sha256:d806cf915b29fa952e43ab4aaf02431cc39dfdde6a29b0d20509a07562eaaec5",
    }

    first = client.post("/v1/creator/releases", json=request, headers=creator_publish_headers())
    replay = client.post("/v1/creator/releases", json=request, headers=creator_publish_headers())

    assert first.status_code == 201
    assert replay.status_code == 201
    assert first.json()["release_id"] == request["release_id"]
    assert first.json()["release_digest"] == request["release_digest"]
    assert replay.json() == first.json()
    fetched = client.get("/v1/creator-releases/signal-resume-review@1.0.0")
    assert fetched.status_code == 200
    assert fetched.json() == first.json()
    listed = client.get("/v1/creator/maya-chen/releases")
    assert listed.status_code == 200
    assert listed.json() == [first.json()]


def test_creator_publish_rejects_digest_rebinding() -> None:
    client = make_client()
    request = {
        "release_id": "signal-resume-review@1.0.0",
        "release_digest": "sha256:d806cf915b29fa952e43ab4aaf02431cc39dfdde6a29b0d20509a07562eaaec5",
    }
    assert client.post(
        "/v1/creator/releases",
        json=request,
        headers=creator_publish_headers(),
    ).status_code == 201

    conflict = client.post(
        "/v1/creator/releases",
        json={**request, "release_digest": f"sha256:{'f' * 64}"},
        headers=creator_publish_headers(),
    )

    assert conflict.status_code == 409
    assert "different digest" in conflict.json()["detail"]


def test_creator_publication_survives_registry_restart(tmp_path: Path) -> None:
    state_path = tmp_path / "registry" / "state.json"
    request = {
        "release_id": "signal-resume-review@1.0.0",
        "release_digest": "sha256:d806cf915b29fa952e43ab4aaf02431cc39dfdde6a29b0d20509a07562eaaec5",
    }
    first_process = make_client(state_path=state_path)
    published = first_process.post(
        "/v1/creator/releases",
        json=request,
        headers=creator_publish_headers(),
    )
    assert published.status_code == 201
    assert state_path.is_file()

    second_process = make_client(state_path=state_path)
    fetched = second_process.get("/v1/creator-releases/signal-resume-review@1.0.0")
    replay = second_process.post(
        "/v1/creator/releases",
        json=request,
        headers=creator_publish_headers(),
    )

    assert fetched.status_code == 200
    assert fetched.json() == published.json()
    assert replay.status_code == 201
    assert replay.json() == published.json()


def test_app_uses_env_configured_creator_release_state(
    tmp_path: Path,
    monkeypatch,
) -> None:
    state_path = tmp_path / "configured-registry-state.json"
    monkeypatch.setenv("HATCH_CREATOR_RELEASE_ROOT", str(release_root()))
    monkeypatch.setenv("HATCH_REGISTRY_STATE_PATH", str(state_path))
    request = {
        "release_id": "signal-resume-review@1.0.0",
        "release_digest": "sha256:d806cf915b29fa952e43ab4aaf02431cc39dfdde6a29b0d20509a07562eaaec5",
    }
    first_app = TestClient(create_app(publish_service_token=PUBLISH_SERVICE_TOKEN))
    published = first_app.post(
        "/v1/creator/releases",
        json=request,
        headers=creator_publish_headers(),
    )
    assert published.status_code == 201

    restarted_app = TestClient(create_app(publish_service_token=PUBLISH_SERVICE_TOKEN))
    fetched = restarted_app.get("/v1/creator-releases/signal-resume-review@1.0.0")

    assert fetched.status_code == 200
    assert fetched.json() == published.json()


def test_creator_publication_rejects_digest_rebinding_after_restart(tmp_path: Path) -> None:
    state_path = tmp_path / "registry-state.json"
    request = {
        "release_id": "signal-resume-review@1.0.0",
        "release_digest": "sha256:d806cf915b29fa952e43ab4aaf02431cc39dfdde6a29b0d20509a07562eaaec5",
    }
    first_process = make_client(state_path=state_path)
    assert first_process.post(
        "/v1/creator/releases",
        json=request,
        headers=creator_publish_headers(),
    ).status_code == 201

    second_process = make_client(state_path=state_path)
    conflict = second_process.post(
        "/v1/creator/releases",
        json={**request, "release_digest": f"sha256:{'f' * 64}"},
        headers=creator_publish_headers(),
    )

    assert conflict.status_code == 409
    assert "different digest" in conflict.json()["detail"]
    persisted = second_process.get("/v1/creator-releases/signal-resume-review@1.0.0")
    assert persisted.status_code == 200
    assert persisted.json()["release_digest"] == request["release_digest"]


def test_creator_publish_requires_service_token_and_creator_identity() -> None:
    client = make_client()
    request = {
        "release_id": "signal-resume-review@1.0.0",
        "release_digest": "sha256:d806cf915b29fa952e43ab4aaf02431cc39dfdde6a29b0d20509a07562eaaec5",
    }

    missing = client.post("/v1/creator/releases", json=request)
    wrong_token = client.post(
        "/v1/creator/releases",
        json=request,
        headers={
            "authorization": "Bearer wrong-token",
            "x-hatch-creator-id": "maya-chen",
        },
    )
    missing_creator = client.post(
        "/v1/creator/releases",
        json=request,
        headers={"authorization": f"Bearer {PUBLISH_SERVICE_TOKEN}"},
    )

    assert missing.status_code == 401
    assert wrong_token.status_code == 401
    assert missing_creator.status_code == 400


def test_creator_publish_fails_closed_when_service_token_is_not_configured() -> None:
    client = make_client("")
    request = {
        "release_id": "signal-resume-review@1.0.0",
        "release_digest": "sha256:d806cf915b29fa952e43ab4aaf02431cc39dfdde6a29b0d20509a07562eaaec5",
    }

    response = client.post(
        "/v1/creator/releases",
        json=request,
        headers=creator_publish_headers(),
    )

    assert response.status_code == 503
    assert client.get("/v1/creator-releases/signal-resume-review@1.0.0").status_code == 404


def test_creator_publish_rejects_release_owned_by_another_creator() -> None:
    client = make_client()
    request = {
        "release_id": "signal-resume-review@1.0.0",
        "release_digest": "sha256:d806cf915b29fa952e43ab4aaf02431cc39dfdde6a29b0d20509a07562eaaec5",
    }

    response = client.post(
        "/v1/creator/releases",
        json=request,
        headers=creator_publish_headers("another-creator"),
    )

    assert response.status_code == 403
    assert client.get("/v1/creator-releases/signal-resume-review@1.0.0").status_code == 404
