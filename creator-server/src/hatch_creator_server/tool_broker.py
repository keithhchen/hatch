from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from itertools import count
from typing import Any

from hatch_creator_server.protocol import ToolRequest, ToolResult, dump_message


SendJson = Callable[[dict[str, Any]], Awaitable[None]]


class LocalToolBroker:
    """Proxy creator-side local tool calls over the runner WebSocket."""

    def __init__(self, send_json: SendJson, *, timeout_seconds: float = 10.0) -> None:
        self._send_json = send_json
        self._timeout_seconds = timeout_seconds
        self._ids = count(1)
        self._pending: dict[tuple[str, str], asyncio.Future[ToolResult]] = {}

    async def request(self, *, turn_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        tool_call_id = f"tool_{next(self._ids)}"
        loop = asyncio.get_running_loop()
        future: asyncio.Future[ToolResult] = loop.create_future()
        key = (turn_id, tool_call_id)
        self._pending[key] = future

        request = ToolRequest(
            turn_id=turn_id,
            tool_call_id=tool_call_id,
            name=name,
            arguments=arguments,
        )

        try:
            await self._send_json(dump_message(request))
            result = await asyncio.wait_for(future, timeout=self._timeout_seconds)
            return result.output
        finally:
            self._pending.pop(key, None)

    async def local_search(
        self,
        *,
        turn_id: str,
        query: str,
        scope: str = "workspace/",
        limit: int = 5,
    ) -> dict[str, Any]:
        return await self.request(
            turn_id=turn_id,
            name="local.search",
            arguments={
                "query": query,
                "scope": scope,
                "limit": limit,
            },
        )

    async def local_list(self, *, turn_id: str, path: str = "workspace") -> dict[str, Any]:
        return await self.request(
            turn_id=turn_id,
            name="local.list",
            arguments={"path": path},
        )

    async def local_read(self, *, turn_id: str, path: str) -> dict[str, Any]:
        return await self.request(
            turn_id=turn_id,
            name="local.read",
            arguments={"path": path},
        )

    async def local_write(self, *, turn_id: str, path: str, content: str) -> dict[str, Any]:
        return await self.request(
            turn_id=turn_id,
            name="local.write",
            arguments={"path": path, "content": content},
        )

    async def handle_tool_result(self, result: ToolResult) -> bool:
        future = self._pending.get((result.turn_id, result.tool_call_id))
        if future is None or future.done():
            return False

        future.set_result(result)
        return True

    def cancel_pending(self) -> None:
        for future in list(self._pending.values()):
            if not future.done():
                future.cancel()
        self._pending.clear()
