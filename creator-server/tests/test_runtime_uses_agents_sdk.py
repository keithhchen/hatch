from pathlib import Path


def test_creator_runtime_does_not_call_model_api_directly() -> None:
    adapter = (
        Path(__file__).parents[1]
        / "src"
        / "hatch_creator_server"
        / "adapters"
        / "openai_agents.py"
    )
    source = adapter.read_text()

    assert "Runner.run(" in source
    assert "Agent(" in source
    assert "@function_tool" in source
    assert ".chat.completions.create" not in source
    assert ".responses.create" not in source
