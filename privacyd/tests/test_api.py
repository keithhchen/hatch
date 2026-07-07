from fastapi.testclient import TestClient

from privacyd.api import PrivacyService, create_app
from privacyd.entity_map import EntityMapper


def test_sanitize_endpoint_returns_sanitized_context() -> None:
    app = create_app(
        PrivacyService(entity_mapper=EntityMapper(root_secret=b"api-test-root"))
    )
    client = TestClient(app)

    response = client.post(
        "/sanitize",
        json={
            "app_id": "app.alpha",
            "text": "Contact Alice Example at alice@example.test.",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["sanitized_text"] == "Contact PERSON_A at EMAIL_A."
    assert {finding["kind"] for finding in body["findings"]} == {"PERSON", "EMAIL"}


def test_sanitize_endpoint_rejects_blank_app_id() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/sanitize",
        json={
            "app_id": "   ",
            "text": "Lorem ipsum for Alice Example.",
        },
    )

    assert response.status_code == 422
