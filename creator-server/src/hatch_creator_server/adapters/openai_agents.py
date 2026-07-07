from __future__ import annotations

from collections.abc import AsyncIterator
import os

from openai import AsyncOpenAI

from hatch_creator_server.protocol import AgentDelta, OutboundMessage, TurnFinal, TurnStart
from hatch_creator_server.runtime import CreatorRuntime
from hatch_creator_server.skill_module import CreatorSkill
from hatch_creator_server.tool_broker import LocalToolBroker


class OpenAIAgentsRuntimeAdapter(CreatorRuntime):
    """Real OpenAI Agents SDK runtime with brokered local tools."""

    def __init__(
        self,
        *,
        skill: CreatorSkill,
        client: AsyncOpenAI | None = None,
        model: str | None = None,
    ) -> None:
        api_key = os.environ.get("OPENAI_API_KEY")
        base_url = os.environ.get("OPENAI_BASE_URL")
        if client is None and not api_key:
            raise RuntimeError("OPENAI_API_KEY is required for the creator runtime")

        # Provider configuration only. Agent execution stays inside OpenAI Agents SDK.
        self._client = client or AsyncOpenAI(api_key=api_key, base_url=base_url)
        self._model = model or os.environ.get("HATCH_CREATOR_MODEL") or "deepseek-v4"
        self._skill = skill

    async def run_turn(
        self,
        turn: TurnStart,
        tools: LocalToolBroker,
    ) -> AsyncIterator[OutboundMessage]:
        from agents import Agent, Runner, function_tool, set_tracing_disabled
        from agents.models.openai_chatcompletions import OpenAIChatCompletionsModel

        set_tracing_disabled(True)

        @function_tool(name_override="local_search")
        async def local_search(query: str, scope: str = "workspace/", limit: int = 5) -> dict:
            """Search sanitized snippets in the user's local app sandbox."""
            self._ensure_tool_allowed("local.search")
            return await tools.local_search(
                turn_id=turn.turn_id,
                query=query,
                scope=scope,
                limit=limit,
            )

        @function_tool(name_override="local_list")
        async def local_list(path: str = "workspace") -> dict:
            """List files in the user's local app sandbox."""
            self._ensure_tool_allowed("local.list")
            return await tools.local_list(turn_id=turn.turn_id, path=path)

        @function_tool(name_override="local_read")
        async def local_read(path: str) -> dict:
            """Read a UTF-8 file from the user's local app sandbox."""
            self._ensure_tool_allowed("local.read")
            return await tools.local_read(turn_id=turn.turn_id, path=path)

        @function_tool(name_override="local_write")
        async def local_write(path: str, content: str) -> dict:
            """Write a UTF-8 file inside the user's local app sandbox."""
            self._ensure_tool_allowed("local.write")
            return await tools.local_write(turn_id=turn.turn_id, path=path, content=content)

        agent = Agent(
            name=self._skill.name,
            instructions=self._skill.instructions,
            model=OpenAIChatCompletionsModel(
                model=self._model,
                openai_client=self._client,
                strict_feature_validation=False,
            ),
            tools=[local_search, local_list, local_read, local_write],
        )

        yield AgentDelta(
            turn_id=turn.turn_id,
            delta={"type": "text", "content": "Running creator skill runtime."},
        )

        result = await Runner.run(
            agent,
            input=[
                {"role": message.role, "content": message.content}
                for message in turn.input
            ],
            max_turns=4,
        )

        yield TurnFinal(
            turn_id=turn.turn_id,
            output=[{"type": "message", "content": str(result.final_output)}],
            usage=_usage_dict(result),
        )

    def _ensure_tool_allowed(self, name: str) -> None:
        if name not in self._skill.allowed_tools:
            raise RuntimeError(f"tool is not allowed by skill module: {name}")


def _usage_dict(result: object) -> dict[str, int]:
    input_tokens = 0
    output_tokens = 0
    for response in getattr(result, "raw_responses", []) or []:
        usage = getattr(response, "usage", None)
        if usage is None:
            continue
        input_tokens += int(
            getattr(usage, "input_tokens", 0) or getattr(usage, "prompt_tokens", 0) or 0
        )
        output_tokens += int(
            getattr(usage, "output_tokens", 0) or getattr(usage, "completion_tokens", 0) or 0
        )
    return {"input_tokens": input_tokens, "output_tokens": output_tokens}
