import base64
import json
import logging
import sqlite3
import time
from contextvars import ContextVar
from contextlib import asynccontextmanager
from functools import partial
from typing import Annotated, Any

import anyio
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field

from app.config import MCP_ALLOWED_HOSTS
from app.errors import GatewayError
from app.filesystem import find_files, grep_files, read_file, readdir, stat_path
from app.store import Product, ProductStore

store = ProductStore()
current_product: ContextVar[Product] = ContextVar("current_product")


class BearerAuthMiddleware:
    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_messages = []
        request_body = bytearray()
        while True:
            message = await receive()
            request_messages.append(message)
            if message["type"] == "http.request":
                request_body.extend(message.get("body", b""))
                if not message.get("more_body", False):
                    break
            elif message["type"] == "http.disconnect":
                break

        async def replay_receive() -> dict[str, Any]:
            if request_messages:
                return request_messages.pop(0)
            return await receive()

        response_status = None

        async def capture_send(message: dict[str, Any]) -> None:
            nonlocal response_status
            if message["type"] == "http.response.start":
                response_status = message["status"]
            await send(message)

        headers = [
            [name.decode("latin1"), "[REDACTED]" if name.lower() == b"authorization" else value.decode("latin1")]
            for name, value in scope.get("headers", [])
        ]
        try:
            body_record = {"body": request_body.decode("utf-8", errors="strict")}
        except UnicodeDecodeError:
            body_record = {"body_base64": base64.b64encode(request_body).decode("ascii")}
        client = scope.get("client")
        request_record = {
            "method": scope.get("method"),
            "scheme": scope.get("scheme"),
            "path": scope.get("path"),
            "raw_path": scope.get("raw_path", b"").decode("latin1"),
            "query_string": scope.get("query_string", b"").decode("latin1"),
            "headers": headers,
            "client": list(client) if client else None,
            **body_record,
        }
        started_at = time.monotonic()
        try:
            if scope.get("path") == "/healthz":
                await self.app(scope, replay_receive, capture_send)
                return
            authorization = next(
                (value.decode("latin1") for name, value in scope.get("headers", []) if name.lower() == b"authorization"),
                "",
            )
            prefix, separator, key = authorization.partition(" ")
            if prefix.lower() != "bearer" or not separator or not key or key.strip() != key:
                await self._send_error(capture_send, GatewayError(401, "INVALID_CREDENTIALS", "Bearer key is missing or invalid"))
                return
            try:
                product = store.find_key(key)
            except GatewayError as error:
                await self._send_error(capture_send, error)
                return
            except (OSError, sqlite3.Error):
                await self._send_error(
                    capture_send,
                    GatewayError(500, "SERVICE_INTERNAL_ERROR", "NAS Gateway could not complete the request"),
                )
                return
            scope.setdefault("state", {})["nas_product"] = product
            request_record["product_id"] = product.product_id
            context_token = current_product.set(product)
            try:
                await self.app(scope, replay_receive, capture_send)
            finally:
                current_product.reset(context_token)
        finally:
            request_record["response_status"] = response_status
            request_record["duration_ms"] = round((time.monotonic() - started_at) * 1000, 3)
            logging.getLogger("uvicorn.error").info("nas_gateway_request %s", json.dumps(request_record, ensure_ascii=False))

    @staticmethod
    async def _send_error(send: Any, error: GatewayError) -> None:
        body = json.dumps({"error": {"code": error.code, "message": error.message}}).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": error.status_code,
                "headers": [(b"content-type", b"application/json; charset=utf-8"), (b"content-length", str(len(body)).encode())],
            }
        )
        await send({"type": "http.response.body", "body": body})


mcp = FastMCP(
    "NAS Gateway",
    stateless_http=True,
    json_response=True,
    transport_security=TransportSecuritySettings(allowed_hosts=list(MCP_ALLOWED_HOSTS)),
)


def active_product() -> Product:
    try:
        return current_product.get()
    except LookupError as error:
        raise GatewayError(401, "INVALID_CREDENTIALS", "Bearer key is missing or invalid") from error


def mcp_call(operation: Any, *args: Any, **kwargs: Any) -> Any:
    try:
        return operation(active_product(), *args, **kwargs)
    except GatewayError as error:
        raise ToolError(f"{error.code}: {error.message}") from error
    except (OSError, sqlite3.Error) as error:
        raise ToolError("SERVICE_INTERNAL_ERROR: NAS Gateway could not complete the request") from error


async def mcp_call_async(operation: Any, *args: Any, **kwargs: Any) -> Any:
    return await anyio.to_thread.run_sync(partial(mcp_call, operation, *args, **kwargs))


@mcp.tool(name="readdir")
async def readdir_tool(path: str = "") -> dict[str, object]:
    """List direct child names and types in stable order; results may be truncated at the configured directory limit."""
    return await mcp_call_async(readdir, path)


@mcp.tool(name="stat")
async def stat_tool(path: str) -> dict[str, object]:
    """Return POSIX stat fields for a file or directory; symbolic links are rejected at the product boundary."""
    return await mcp_call_async(stat_path, path)


@mcp.tool(name="read")
async def read_tool(path: str, offset: int = 0, length: int = 4096) -> dict[str, object]:
    """Read a file range and return its path, byte offset, bytes read, and content encoding.

    `offset` and `length` are measured in bytes. `offset` defaults to 0 and `length`
    defaults to 4096. For contextual reading, prefer one call with `length=16384`;
    if the file is shorter than the requested range, it is returned in one call.
    Use smaller ranges only to inspect a specific passage and avoid overlapping reads.
    Valid UTF-8 is returned as `content` with `encoding=utf-8`; other byte ranges are
    returned as `content_base64` with `encoding=base64`. The service enforces its
    configured maximum read length.
    """
    return await mcp_call_async(read_file, path, offset, length)


@mcp.tool(name="find")
async def find_tool(path: str = "", name_pattern: str = "*", type: str = "any") -> dict[str, object]:
    """Find files and directories recursively by basename glob; results may be truncated at the configured limit."""
    return await mcp_call_async(find_files, path, name_pattern, type)


@mcp.tool(name="grep")
async def grep_tool(
    pattern: Annotated[str, Field(min_length=1)],
    path: str = "",
    recursive: bool = True,
    glob: str = "*",
    case_sensitive: bool = True,
    max_results: int = 100,
) -> dict[str, object]:
    """Search UTF-8 text lines with a Python `re` regular expression.

    `pattern` is required and must be non-empty. An empty pattern would match every
    line, so it is rejected. `path` may name one file or a directory. An empty `path`
    searches from the product root. Directories are recursive by default;
    `recursive=false` searches only direct child files. `glob` filters basenames.
    Matching is case-sensitive by default.
    For an initial broad search, search the relevant directory recursively and set
    `max_results=50`. This limit counts matching lines. If `truncated=true` and more
    results are needed, retry with `max_results=100`. Each result contains `path`,
    a 1-based `line` number, and the full matching `text`. The response also reports
    `scanned_files`, `scanned_bytes`, `skipped_non_text_files`, and `truncated`.
    Files with invalid UTF-8 or NUL bytes are skipped and counted.
    """
    return await mcp_call_async(grep_files, path, pattern, recursive, glob, case_sensitive, max_results)


@asynccontextmanager
async def lifespan(_: FastAPI):
    async with mcp.session_manager.run():
        yield


app = FastAPI(title="NAS Gateway", version="1.0.0", lifespan=lifespan)


@app.exception_handler(GatewayError)
async def gateway_error_handler(_: Request, error: GatewayError) -> JSONResponse:
    return JSONResponse(
        status_code=error.status_code,
        content={"error": {"code": error.code, "message": error.message}},
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, error: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={"error": {"code": "INVALID_ARGUMENT", "message": "Request parameters are invalid"}},
    )


@app.exception_handler(OSError)
@app.exception_handler(sqlite3.Error)
async def internal_service_error_handler(_: Request, error: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "SERVICE_INTERNAL_ERROR", "message": "NAS Gateway could not complete the request"}},
    )


@app.get("/healthz")
def healthz() -> dict[str, str]:
    with store.connect() as connection:
        connection.execute("SELECT 1").fetchone()
    return {"status": "ok"}


@app.post("/v1/tools/readdir")
def http_readdir(body: dict[str, Any]) -> dict[str, object]:
    return readdir(active_product(), body.get("path", ""))


@app.post("/v1/tools/stat")
def http_stat(body: dict[str, Any]) -> dict[str, object]:
    return stat_path(active_product(), body.get("path"))


@app.post("/v1/tools/read")
def http_read(body: dict[str, Any]) -> dict[str, object]:
    return read_file(active_product(), body.get("path"), body.get("offset", 0), body.get("length", 4096))


@app.post("/v1/tools/find")
def http_find(body: dict[str, Any]) -> dict[str, object]:
    return find_files(
        active_product(),
        body.get("path", ""),
        body.get("name_pattern", "*"),
        body.get("type", "any"),
    )


@app.post("/v1/tools/grep")
def http_grep(body: dict[str, Any]) -> dict[str, object]:
    return grep_files(
        active_product(),
        body.get("path", ""),
        body.get("pattern", ""),
        body.get("recursive", True),
        body.get("glob", "*"),
        body.get("case_sensitive", True),
        body.get("max_results", 100),
    )


app.mount("/", mcp.streamable_http_app())
app.add_middleware(BearerAuthMiddleware)
