import asyncio
import json
import os
import urllib.error
import urllib.request

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


BASE_URL = os.environ["NAS_GATEWAY_VERIFY_URL"].rstrip("/")
KEY = os.environ["NAS_GATEWAY_VERIFY_KEY"]


def request_json(path: str, body: dict[str, object] | None = None, key: str | None = KEY) -> tuple[int, dict[str, object]]:
    headers = {"Content-Type": "application/json"}
    if key is not None:
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers=headers,
        method="GET" if body is None else "POST",
    )
    try:
        response = urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())
    with response:
        return response.status, json.loads(response.read())


def verify_http() -> None:
    status, health = request_json("/healthz", key=None)
    assert status == 200 and health == {"status": "ok"}

    status, listing = request_json("/v1/tools/readdir", {"path": ""})
    assert status == 200 and isinstance(listing["entries"], list)

    status, result = request_json("/v1/tools/find", {"path": "", "name_pattern": "*", "type": "any"})
    assert status == 200 and isinstance(result["matches"], list)

    status, result = request_json(
        "/v1/tools/grep",
        {"path": "", "pattern": "nas-gateway-smoke-pattern", "recursive": True, "glob": "*", "case_sensitive": True, "max_results": 10},
    )
    assert status == 200 and isinstance(result["matches"], list)

    status, error = request_json("/v1/tools/stat", {"path": "nas-gateway-smoke-missing"})
    assert status == 404 and error["error"]["code"] == "PATH_NOT_FOUND"

    status, error = request_json("/v1/tools/read", {"path": "nas-gateway-smoke-missing", "offset": 0, "length": 1})
    assert status == 404 and error["error"]["code"] == "PATH_NOT_FOUND"

    status, error = request_json("/v1/tools/readdir", {"path": "../dify"})
    assert status == 403 and error["error"]["code"] == "PATH_OUTSIDE_ROOT"

    status, error = request_json("/v1/tools/readdir", {"path": ""}, key=None)
    assert status == 401 and error["error"]["code"] == "INVALID_CREDENTIALS"


async def verify_mcp() -> None:
    async with httpx.AsyncClient(headers={"Authorization": f"Bearer {KEY}"}) as client:
        async with streamable_http_client(f"{BASE_URL}/mcp", http_client=client) as (read_stream, write_stream, _):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                tools = await session.list_tools()
                names = {tool.name for tool in tools.tools}
                assert names == {"readdir", "stat", "read", "find", "grep"}
                result = await session.call_tool("readdir", {"path": ""})
                assert not result.isError


def main() -> None:
    verify_http()
    asyncio.run(verify_mcp())
    print("NAS Gateway HTTP and MCP verification passed")


if __name__ == "__main__":
    main()
