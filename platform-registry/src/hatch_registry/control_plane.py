from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal


class ControlPlaneError(ValueError):
    pass


@dataclass(frozen=True)
class ToolConnection:
    id: str
    tenant_id: str
    kind: Literal["http", "mcp"]
    secret_ref: str | None
    config: dict[str, Any]
    status: Literal["active", "disabled"]


class ControlPlaneStore:
    """Persistent HTTP/MCP connection bindings, never credentials.

    The database stores a secret *reference* and non-secret endpoint metadata.
    A Corpus declares a creator tool as ``http_function`` or ``mcp_tool``. This
    store maps its ``connection_ref`` to the physical HTTP/MCP connection. A
    Runtime resolves the reference with its Secret Manager only immediately
    before a call. SQLite is the local/server default; production may place the
    same small relational model in Postgres without changing the API.
    """

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path.expanduser()
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def upsert_connection(
        self,
        *,
        tenant_id: str,
        connection_id: str,
        kind: Literal["http", "mcp"],
        secret_ref: str | None,
        config: dict[str, Any],
        status: Literal["active", "disabled"],
    ) -> ToolConnection:
        _require_identifier(tenant_id, "tenant_id")
        _require_identifier(connection_id, "connection_id")
        _validate_config(config)
        if secret_ref is not None and not secret_ref.strip():
            raise ControlPlaneError("secret_ref cannot be blank")
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO tool_connections (id, tenant_id, kind, secret_ref, config_json, status)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  tenant_id=excluded.tenant_id,
                  kind=excluded.kind,
                  secret_ref=excluded.secret_ref,
                  config_json=excluded.config_json,
                  status=excluded.status
                """,
                (connection_id, tenant_id, kind, secret_ref, _encode(config), status),
            )
        return ToolConnection(connection_id, tenant_id, kind, secret_ref, config, status)

    def bind_agent_tool(
        self,
        *,
        tenant_id: str,
        agent_id: str,
        tool_id: str,
        connection_id: str,
    ) -> None:
        _require_identifier(tenant_id, "tenant_id")
        _require_identifier(agent_id, "agent_id")
        _require_identifier(tool_id, "tool_id")
        _require_identifier(connection_id, "connection_id")
        with self._connect() as connection:
            existing = connection.execute(
                "SELECT tenant_id FROM tool_connections WHERE id = ?", (connection_id,)
            ).fetchone()
            if existing is None:
                raise ControlPlaneError(f"tool connection does not exist: {connection_id}")
            if existing["tenant_id"] != tenant_id:
                raise ControlPlaneError("a tool connection cannot cross tenant boundaries")
            connection.execute(
                """
                INSERT INTO agent_tool_bindings (tenant_id, agent_id, tool_id, connection_id)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(tenant_id, agent_id, tool_id)
                DO UPDATE SET connection_id=excluded.connection_id
                """,
                (tenant_id, agent_id, tool_id, connection_id),
            )

    def get_connection(self, *, tenant_id: str, connection_id: str) -> ToolConnection:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id, tenant_id, kind, secret_ref, config_json, status FROM tool_connections WHERE id = ? AND tenant_id = ?",
                (connection_id, tenant_id),
            ).fetchone()
        if row is None:
            raise ControlPlaneError(f"tool connection does not exist for this tenant: {connection_id}")
        return ToolConnection(
            id=row["id"], tenant_id=row["tenant_id"], kind=row["kind"], secret_ref=row["secret_ref"],
            config=_decode(row["config_json"]), status=row["status"],
        )

    def resolve(self, *, tenant_id: str, agent_id: str, tool_id: str) -> ToolConnection:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT c.id, c.tenant_id, c.kind, c.secret_ref, c.config_json, c.status
                FROM agent_tool_bindings AS b
                JOIN tool_connections AS c ON c.id = b.connection_id
                WHERE b.tenant_id = ? AND b.agent_id = ? AND b.tool_id = ?
                """,
                (tenant_id, agent_id, tool_id),
            ).fetchone()
        if row is None:
            raise ControlPlaneError(f"no Control Plane binding for {tenant_id}/{agent_id}/{tool_id}")
        if row["status"] != "active":
            raise ControlPlaneError(f"tool connection is not active: {row['id']}")
        return ToolConnection(
            id=row["id"],
            tenant_id=row["tenant_id"],
            kind=row["kind"],
            secret_ref=row["secret_ref"],
            config=_decode(row["config_json"]),
            status=row["status"],
        )

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS tool_connections (
                  id TEXT PRIMARY KEY,
                  tenant_id TEXT NOT NULL,
                  kind TEXT NOT NULL CHECK(kind IN ('http', 'mcp')),
                  secret_ref TEXT,
                  config_json TEXT NOT NULL,
                  status TEXT NOT NULL CHECK(status IN ('active', 'disabled'))
                );
                CREATE TABLE IF NOT EXISTS agent_tool_bindings (
                  tenant_id TEXT NOT NULL,
                  agent_id TEXT NOT NULL,
                  tool_id TEXT NOT NULL,
                  connection_id TEXT NOT NULL REFERENCES tool_connections(id),
                  PRIMARY KEY (tenant_id, agent_id, tool_id)
                );
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection


def _require_identifier(value: str, field: str) -> None:
    if not value or any(character.isspace() for character in value):
        raise ControlPlaneError(f"{field} must be a non-empty identifier")


def _validate_config(config: dict[str, Any]) -> None:
    if not isinstance(config, dict) or not isinstance(config.get("url"), str) or not config["url"].startswith(("https://", "http://")):
        raise ControlPlaneError("connection config requires an http(s) url")
    _reject_secret_fields(config)


def _reject_secret_fields(value: Any) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = key.lower().replace("-", "_")
            if normalized in {"authorization", "api_key", "apikey", "token", "password", "secret", "bearer"}:
                raise ControlPlaneError("connection config must not contain credentials; use secret_ref")
            _reject_secret_fields(item)
    elif isinstance(value, list):
        for item in value:
            _reject_secret_fields(item)


def _encode(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _decode(value: str) -> dict[str, Any]:
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise ControlPlaneError("stored connection config is invalid")
    return parsed
