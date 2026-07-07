from fastapi.testclient import TestClient

from hatch_creator_server.app import create_app
from hatch_creator_server.skill_module import SkillStore


def test_skill_store_loads_manifest_and_instructions() -> None:
    skill = SkillStore().load("app_lorem_creator")

    assert skill.app_id == "app_lorem_creator"
    assert skill.manifest["name"] == "Lorem Creator App"
    assert "local_search" in skill.instructions
    assert "local.search" in skill.allowed_tools


def test_creator_server_exposes_skill_manifest() -> None:
    client = TestClient(create_app())

    response = client.get("/v1/skills/app_lorem_creator/manifest")

    assert response.status_code == 200
    body = response.json()
    assert body["app_id"] == "app_lorem_creator"
    assert body["runtime"]["websocket_url"] == "ws://127.0.0.1:8200/runtime"
