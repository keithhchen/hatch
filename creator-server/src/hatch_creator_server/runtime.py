from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol

from hatch_creator_server.protocol import AgentDelta, OutboundMessage, TurnFinal, TurnStart
from hatch_creator_server.tool_broker import LocalToolBroker


class CreatorRuntime(Protocol):
    async def run_turn(
        self,
        turn: TurnStart,
        tools: LocalToolBroker,
    ) -> AsyncIterator[OutboundMessage]:
        """Stream Hatch protocol events for one creator agent turn."""


class FakeDeterministicRuntime:
    """Deterministic local runtime used by tests and no-key development."""

    async def run_turn(
        self,
        turn: TurnStart,
        tools: LocalToolBroker,
    ) -> AsyncIterator[OutboundMessage]:
        query = self._query_for_turn(turn)

        yield AgentDelta(
            turn_id=turn.turn_id,
            delta={
                "type": "text",
                "content": "Searching local workspace for PERSON_A lorem ipsum.",
            },
        )

        search_output = await tools.local_search(
            turn_id=turn.turn_id,
            query=query,
            scope="workspace/",
            limit=5,
        )
        first_ref = self._first_match_ref(search_output)

        yield AgentDelta(
            turn_id=turn.turn_id,
            delta={
                "type": "text",
                "content": f"Found sanitized context in {first_ref}.",
            },
        )
        yield TurnFinal(
            turn_id=turn.turn_id,
            output=[
                {
                    "type": "message",
                    "content": f"lorem ipsum final answer for PERSON_A using {first_ref}.",
                }
            ],
            usage={
                "input_tokens": 42,
                "output_tokens": 17,
            },
        )

    @staticmethod
    def _query_for_turn(turn: TurnStart) -> str:
        content = " ".join(message.content for message in turn.input)
        if "PERSON_A" in content:
            return "PERSON_A lorem ipsum"
        return "lorem ipsum"

    @staticmethod
    def _first_match_ref(search_output: dict[str, object]) -> str:
        matches = search_output.get("matches")
        if not isinstance(matches, list) or not matches:
            return "SNIPPET_A"

        first = matches[0]
        if isinstance(first, dict):
            ref = first.get("ref")
            if isinstance(ref, str) and ref:
                return ref

        return "SNIPPET_A"
