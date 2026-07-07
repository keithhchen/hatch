import base64

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi.testclient import TestClient

from hatch_registry.app import create_app
from hatch_registry.models import AppManifest
from hatch_registry.signing import canonical_manifest_bytes


def make_client() -> TestClient:
    return TestClient(create_app())


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
            "websocket_url": "ws://localhost:8200/runtime",
            "protocol_version": "0.1",
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


def _decode_unpadded_base64(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}")
