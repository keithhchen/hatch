from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

import pytest
import uvicorn
import websockets

from hatch_creator_server.app import create_app
from hatch_creator_server.runtime import FakeDeterministicRuntime


@pytest.fixture
def app():
    return create_app(runtime_factory=lambda _hello: FakeDeterministicRuntime())


@pytest.fixture
async def websocket_url(app, unused_tcp_port: int) -> AsyncIterator[str]:
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=unused_tcp_port,
        log_level="warning",
        lifespan="on",
    )
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())

    for _ in range(100):
        if server.started:
            break
        await asyncio.sleep(0.01)
    else:
        server.should_exit = True
        await task
        raise RuntimeError("uvicorn test server did not start")

    yield f"ws://127.0.0.1:{unused_tcp_port}/runtime"

    server.should_exit = True
    await task


async def recv_json(ws) -> dict:
    return json.loads(await ws.recv())


@pytest.mark.asyncio
async def test_runtime_turn_requests_local_search_and_finalizes(websocket_url: str) -> None:
    async with websockets.connect(websocket_url) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "runtime.hello",
                    "app_id": "app_a",
                    "installation_id": "inst_x",
                    "license_token": "lic_x",
                    "runner_version": "0.1.0",
                    "protocol_version": "0.1",
                }
            )
        )
        assert await recv_json(ws) == {
            "type": "runtime.ready",
            "app_id": "app_a",
            "accepted_protocol_version": "0.1",
        }

        await ws.send(
            json.dumps(
                {
                    "type": "turn.start",
                    "turn_id": "turn_x",
                    "conversation_id": "conv_y",
                    "input": [
                        {
                            "role": "user",
                            "content": "lorem ipsum about PERSON_A",
                        },
                        {
                            "role": "user",
                            "content": "<sanitized_context>PERSON_A lorem ipsum from FILE_A</sanitized_context>",
                        },
                    ],
                    "local_tools": ["local.search"],
                }
            )
        )

        first_delta = await recv_json(ws)
        assert first_delta == {
            "type": "agent.delta",
            "turn_id": "turn_x",
            "delta": {
                "type": "text",
                "content": "Searching local workspace for PERSON_A lorem ipsum.",
            },
        }

        tool_request = await recv_json(ws)
        assert tool_request == {
            "type": "tool.request",
            "turn_id": "turn_x",
            "tool_call_id": "tool_1",
            "name": "local.search",
            "arguments": {
                "query": "PERSON_A lorem ipsum",
                "scope": "workspace/",
                "limit": 5,
            },
        }

        await ws.send(
            json.dumps(
                {
                    "type": "tool.result",
                    "turn_id": "turn_x",
                    "tool_call_id": "tool_1",
                    "output": {
                        "matches": [
                            {
                                "ref": "SNIPPET_A",
                                "file_ref": "FILE_A",
                                "text": "PERSON_A previously said lorem ipsum.",
                                "score": 0.82,
                            }
                        ]
                    },
                }
            )
        )

        second_delta = await recv_json(ws)
        assert second_delta == {
            "type": "agent.delta",
            "turn_id": "turn_x",
            "delta": {
                "type": "text",
                "content": "Found sanitized context in SNIPPET_A.",
            },
        }

        final = await recv_json(ws)
        assert final == {
            "type": "turn.final",
            "turn_id": "turn_x",
            "output": [
                {
                    "type": "message",
                    "content": "lorem ipsum final answer for PERSON_A using SNIPPET_A.",
                }
            ],
            "usage": {
                "input_tokens": 42,
                "output_tokens": 17,
            },
        }


@pytest.mark.asyncio
async def test_turn_start_requires_runtime_hello(websocket_url: str) -> None:
    async with websockets.connect(websocket_url) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "turn.start",
                    "turn_id": "turn_x",
                    "conversation_id": "conv_y",
                    "input": [{"role": "user", "content": "lorem ipsum"}],
                    "local_tools": ["local.search"],
                }
            )
        )

        assert await recv_json(ws) == {
            "type": "runtime.error",
            "error": {
                "code": "hello_required",
                "message": "runtime.hello must be sent before turn messages",
            },
        }


@pytest.mark.asyncio
async def test_unknown_tool_result_reports_runtime_error(websocket_url: str) -> None:
    async with websockets.connect(websocket_url) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "runtime.hello",
                    "app_id": "app_a",
                    "installation_id": "inst_x",
                    "license_token": "lic_x",
                    "protocol_version": "0.1",
                }
            )
        )
        await recv_json(ws)

        await ws.send(
            json.dumps(
                {
                    "type": "tool.result",
                    "turn_id": "turn_x",
                    "tool_call_id": "tool_missing",
                    "output": {"matches": []},
                }
            )
        )

        assert await recv_json(ws) == {
            "type": "runtime.error",
            "error": {
                "code": "unknown_tool_call",
                "message": "no pending tool request for tool_missing",
            },
        }


@pytest.mark.asyncio
async def test_runtime_hello_rejects_unsupported_protocol_version(websocket_url: str) -> None:
    async with websockets.connect(websocket_url) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "runtime.hello",
                    "app_id": "app_a",
                    "installation_id": "inst_x",
                    "license_token": "lic_x",
                    "protocol_version": "2099-01-01",
                }
            )
        )

        assert await recv_json(ws) == {
            "type": "runtime.error",
            "error": {
                "code": "unsupported_protocol_version",
                "message": "expected protocol_version 0.1, got 2099-01-01",
            },
        }

        await ws.send(
            json.dumps(
                {
                    "type": "turn.start",
                    "turn_id": "turn_x",
                    "conversation_id": "conv_y",
                    "input": [{"role": "user", "content": "lorem ipsum"}],
                    "local_tools": ["local.search"],
                }
            )
        )

        assert await recv_json(ws) == {
            "type": "runtime.error",
            "error": {
                "code": "hello_required",
                "message": "runtime.hello must be sent before turn messages",
            },
        }
