from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


PROTOCOL_VERSION = "0.1"


class ProtocolError(ValueError):
    """Raised when a WebSocket message cannot be parsed as Hatch protocol."""


class ProtocolModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RuntimeHello(ProtocolModel):
    type: Literal["runtime.hello"]
    app_id: str
    installation_id: str
    license_token: str = Field(min_length=1)
    runner_version: str | None = None
    protocol_version: str = PROTOCOL_VERSION


class RuntimeReady(ProtocolModel):
    type: Literal["runtime.ready"] = "runtime.ready"
    app_id: str
    accepted_protocol_version: str = PROTOCOL_VERSION


class TurnInputMessage(ProtocolModel):
    role: str
    content: str


class TurnStart(ProtocolModel):
    type: Literal["turn.start"]
    turn_id: str
    conversation_id: str
    input: list[TurnInputMessage]
    local_tools: list[str] = Field(default_factory=list)


class AgentDelta(ProtocolModel):
    type: Literal["agent.delta"] = "agent.delta"
    turn_id: str
    delta: dict[str, Any]


class ToolRequest(ProtocolModel):
    type: Literal["tool.request"] = "tool.request"
    turn_id: str
    tool_call_id: str
    name: str
    arguments: dict[str, Any]


class ToolResult(ProtocolModel):
    type: Literal["tool.result"]
    turn_id: str
    tool_call_id: str
    output: dict[str, Any]


class TurnFinal(ProtocolModel):
    type: Literal["turn.final"] = "turn.final"
    turn_id: str
    output: list[dict[str, Any]]
    usage: dict[str, int] = Field(default_factory=dict)


class TurnError(ProtocolModel):
    type: Literal["turn.error"] = "turn.error"
    turn_id: str
    error: dict[str, Any]


class RuntimeErrorMessage(ProtocolModel):
    type: Literal["runtime.error"] = "runtime.error"
    error: dict[str, Any]


InboundMessage = RuntimeHello | TurnStart | ToolResult
OutboundMessage = RuntimeReady | AgentDelta | ToolRequest | TurnFinal | TurnError | RuntimeErrorMessage


_INBOUND_TYPES: dict[str, type[InboundMessage]] = {
    "runtime.hello": RuntimeHello,
    "turn.start": TurnStart,
    "tool.result": ToolResult,
}


def parse_inbound_message(raw: Any) -> InboundMessage:
    if not isinstance(raw, dict):
        raise ProtocolError("message must be a JSON object")

    message_type = raw.get("type")
    if not isinstance(message_type, str):
        raise ProtocolError("message type is required")

    model = _INBOUND_TYPES.get(message_type)
    if model is None:
        raise ProtocolError(f"unsupported message type: {message_type}")

    try:
        return model.model_validate(raw)
    except ValueError as exc:
        raise ProtocolError(str(exc)) from exc


def dump_message(message: OutboundMessage) -> dict[str, Any]:
    return message.model_dump(mode="json", exclude_none=True)
