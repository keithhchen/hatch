import base64
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi.testclient import TestClient

from hatch_registry.app import create_app
from hatch_registry.models import AppManifest
from hatch_registry.signing import canonical_manifest_bytes
from hatch_registry.release_resolver import ReleaseResolver
from hatch_registry.store import RegistryStore

PUBLISH_SERVICE_TOKEN = "registry-publish-test-token"


def release_root() -> Path:
    return (
        Path(__file__).resolve().parents[2]
        / "docs/proof/creator-flow-runtime-v3/release"
    )


def make_client(
    publish_service_token: str = PUBLISH_SERVICE_TOKEN,
    *,
    state_path: Path | None = None,
) -> TestClient:
    return TestClient(create_app(
        RegistryStore.seeded(ReleaseResolver(release_root()), state_path=state_path),
        publish_service_token=publish_service_token,
    ))


def creator_publish_headers(creator_id: str = "maya-chen") -> dict[str, str]:
    return {
        "authorization": f"Bearer {PUBLISH_SERVICE_TOKEN}",
        "x-hatch-creator-id": creator_id,
    }


def test_lists_seeded_manifest_summary() -> None:
    client = make_client()

    response = client.get("/v1/manifests")

    assert response.status_code == 200
    assert response.json() == [
        {
            "app_id": "app_lorem_creator",
            "name": "Lorem Creator App",
            "latest_version": "0.1.0",
            "description": "Synthetic skill-app that searches and edits the user's local lorem workspace.",
            "creator_display_name": "Lorem Creator",
        },
    ]


def test_returns_signed_manifest_by_app_id() -> None:
    client = make_client()

    response = client.get("/v1/manifests/app_lorem_creator")

    assert response.status_code == 200
    body = response.json()
    assert body["manifest"]["app_id"] == "app_lorem_creator"
    assert body["manifest"]["runtime"]["runtime_type"] == "remote_agent"
    assert body["manifest"]["permissions"][0]["key"] == "workspace.read"
    assert body["signature"]["algorithm"] == "ed25519"
    assert body["signature"]["key_id"] == "hatch-dev-ed25519-2026-01"
    assert body["signature"]["public_key"]
    assert body["signature"]["signature"]

    public_key = Ed25519PublicKey.from_public_bytes(
        _decode_unpadded_base64(body["signature"]["public_key"]),
    )
    manifest = AppManifest.model_validate(body["manifest"])
    public_key.verify(
        _decode_unpadded_base64(body["signature"]["signature"]),
        canonical_manifest_bytes(manifest),
    )


def test_returns_latest_version_for_app() -> None:
    client = make_client()

    response = client.get("/v1/apps/app_lorem_creator/latest")

    assert response.status_code == 200
    body = response.json()
    assert body["app_id"] == "app_lorem_creator"
    assert body["version"] == "0.1.0"
    assert body["manifest_url"] == "/v1/manifests/app_lorem_creator"
    assert body["signature"]["algorithm"] == "ed25519"


def test_creator_can_submit_manifest_then_user_can_install() -> None:
    client = make_client()

    manifest = {
        "app_id": "app_lorem_creator",
        "name": "Lorem Creator App",
        "version": "0.1.0",
        "description": "Synthetic creator-submitted app.",
        "creator": {
            "creator_id": "creator_lorem",
            "display_name": "Lorem Creator",
            "support_url": "https://support.example.invalid/lorem",
        },
        "runtime": {
            "runtime_type": "remote_agent",
            "websocket_url": "ws://localhost:8400/runtime",
            "protocol_version": "0.3",
        },
        "permissions": [
            {
                "key": "workspace.read",
                "description": "Read synthetic files inside the app sandbox.",
            }
        ],
        "license": {
            "policy_id": "license_lorem_subscription",
            "plan": "subscription",
            "trial_days": 0,
        },
        "distribution": {
            "channel": "synthetic",
            "install_size_bytes": 4096,
            "manifest_url": "/v1/manifests/app_lorem_creator",
        },
    }

    submit_response = client.post("/v1/creator/manifests", json=manifest)
    assert submit_response.status_code == 201
    assert submit_response.json()["manifest"]["app_id"] == "app_lorem_creator"
    assert submit_response.json()["signature"]["algorithm"] == "ed25519"

    list_response = client.get("/v1/manifests")
    assert list_response.status_code == 200
    assert any(item["app_id"] == "app_lorem_creator" for item in list_response.json())

    install_response = client.post(
        "/v1/installs",
        json={"app_id": "app_lorem_creator", "device_id": "device_lorem_2"},
    )
    assert install_response.status_code == 201
    assert install_response.json()["license_token"].startswith("lic_")


def test_create_install_and_verify_license() -> None:
    client = make_client()

    install_response = client.post(
        "/v1/installs",
        json={"app_id": "app_lorem_creator", "device_id": "device_lorem_1"},
    )

    assert install_response.status_code == 201
    install = install_response.json()
    assert install["install_id"].startswith("inst_")
    assert install["app_id"] == "app_lorem_creator"
    assert install["version"] == "0.1.0"
    assert install["sandbox_hint"] == "apps/app_lorem_creator"
    assert install["license_token"].startswith("lic_")

    verify_response = client.post(
        "/v1/licenses/verify",
        json={
            "app_id": "app_lorem_creator",
            "license_token": install["license_token"],
            "install_id": install["install_id"],
        },
    )

    assert verify_response.status_code == 200
    assert verify_response.json()["valid"] is True
    assert verify_response.json()["status"] == "active"
    assert verify_response.json()["install_id"] == install["install_id"]


def test_verify_license_rejects_unknown_token() -> None:
    client = make_client()

    response = client.post(
        "/v1/licenses/verify",
        json={"app_id": "app_lorem_creator", "license_token": "lic_unknown"},
    )

    assert response.status_code == 200
    assert response.json()["valid"] is False
    assert response.json()["status"] == "invalid"
    assert response.json()["install_id"] is None


def test_unknown_app_returns_404() -> None:
    client = make_client()

    assert client.get("/v1/manifests/app_missing").status_code == 404
    assert client.get("/v1/apps/app_missing/latest").status_code == 404
    install_response = client.post(
        "/v1/installs",
        json={"app_id": "app_missing", "device_id": "device_lorem_1"},
    )
    assert install_response.status_code == 404


def test_creator_publish_pins_exact_release_identity_and_is_idempotent() -> None:
    client = make_client()
    request = {
        "release_id": "signal-resume-review@1.0.0",
        "release_digest": "sha256:1cd3e93b2626aeeaf4041611149b110651a20471ac5f1b16f21e4149f9a9f5c4",
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
        "release_digest": "sha256:1cd3e93b2626aeeaf4041611149b110651a20471ac5f1b16f21e4149f9a9f5c4",
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
        "release_digest": "sha256:1cd3e93b2626aeeaf4041611149b110651a20471ac5f1b16f21e4149f9a9f5c4",
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
        "release_digest": "sha256:1cd3e93b2626aeeaf4041611149b110651a20471ac5f1b16f21e4149f9a9f5c4",
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
        "release_digest": "sha256:1cd3e93b2626aeeaf4041611149b110651a20471ac5f1b16f21e4149f9a9f5c4",
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
        "release_digest": "sha256:1cd3e93b2626aeeaf4041611149b110651a20471ac5f1b16f21e4149f9a9f5c4",
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
        "release_digest": "sha256:1cd3e93b2626aeeaf4041611149b110651a20471ac5f1b16f21e4149f9a9f5c4",
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
        "release_digest": "sha256:1cd3e93b2626aeeaf4041611149b110651a20471ac5f1b16f21e4149f9a9f5c4",
    }

    response = client.post(
        "/v1/creator/releases",
        json=request,
        headers=creator_publish_headers("another-creator"),
    )

    assert response.status_code == 403
    assert client.get("/v1/creator-releases/signal-resume-review@1.0.0").status_code == 404


def _decode_unpadded_base64(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}")
