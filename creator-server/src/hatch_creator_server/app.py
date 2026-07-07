from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Callable
from html import escape
from typing import Any

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware

from hatch_creator_server.protocol import (
    PROTOCOL_VERSION,
    ProtocolError,
    RuntimeErrorMessage,
    RuntimeHello,
    RuntimeReady,
    ToolResult,
    TurnError,
    TurnStart,
    dump_message,
    parse_inbound_message,
)
from hatch_creator_server.runtime import CreatorRuntime, FakeDeterministicRuntime
from hatch_creator_server.skill_module import SkillStore
from hatch_creator_server.tool_broker import LocalToolBroker


RuntimeFactory = Callable[[RuntimeHello], CreatorRuntime]

logger = logging.getLogger(__name__)


def runtime_factory_from_env(hello: RuntimeHello) -> CreatorRuntime:
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required; tests must inject FakeDeterministicRuntime")
    from hatch_creator_server.adapters.openai_agents import OpenAIAgentsRuntimeAdapter

    return OpenAIAgentsRuntimeAdapter(skill=SkillStore().load(hello.app_id))


def create_app(runtime_factory: RuntimeFactory | None = None) -> FastAPI:
    app = FastAPI(title="Hatch Creator Skill Server", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    make_runtime = runtime_factory or runtime_factory_from_env

    @app.get("/healthz")
    async def healthz() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/", response_class=HTMLResponse)
    async def developer_home() -> str:
        skills_root = SkillStore().root
        links = []
        if skills_root.exists():
            for skill_dir in sorted(path for path in skills_root.iterdir() if path.is_dir()):
                if (skill_dir / "SKILL.md").exists():
                    app_id = skill_dir.name
                    links.append(
                        f"""
                        <article class="skill-card">
                          <div class="skill-icon">{escape(app_id[:1].upper())}</div>
                          <div>
                            <p class="eyebrow">private skill module</p>
                            <h2>{escape(app_id)}</h2>
                            <p>Source stays on creator infrastructure. Export only the public manifest.</p>
                          </div>
                          <button class="ghost" data-app-id="{escape(app_id)}">Load manifest</button>
                        </article>
                        """
                    )
        return f"""
        <!doctype html>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Hatch Creator Console</title>
        {creator_styles()}
        <body>
        <header class="topbar">
          <div class="brand"><span class="mark">C</span><strong>Creator Console</strong></div>
          <nav>
            <a href="http://127.0.0.1:8100/">Store</a>
            <a href="http://127.0.0.1:8100/developer">Platform Console</a>
            <a href="/docs">API</a>
          </nav>
        </header>
        <main class="page">
          <section class="hero">
            <div>
              <p class="eyebrow">creator-hosted runtime</p>
              <h1>Keep the skill private. Publish only the manifest.</h1>
              <p class="lead">Edit Skills under <code>{escape(str(skills_root))}</code>. The runtime loads private <code>SKILL.md</code> instructions; Platform receives public metadata and capability declarations.</p>
            </div>
            <aside class="status-panel">
              <div><span>Runtime</span><strong>OpenAI Agents SDK</strong></div>
              <div><span>Protocol</span><strong>{PROTOCOL_VERSION}</strong></div>
              <div><span>Distribution</span><strong>manifest only</strong></div>
            </aside>
          </section>
          <section class="workspace">
            <div class="skills">
              <div class="section-head">
                <div>
                  <p class="eyebrow">private inventory</p>
                  <h2>Skill Modules</h2>
                </div>
              </div>
              <div class="skill-list">{''.join(links)}</div>
            </div>
            <div class="manifest-panel">
              <div class="panel-head">
                <h2>Public Manifest</h2>
                <span class="badge">submit to platform</span>
              </div>
              <textarea id="manifest" spellcheck="false"></textarea>
              <div class="actions">
                <button id="submit" class="primary">Submit To Platform</button>
                <button id="copy" class="ghost" type="button">Copy JSON</button>
              </div>
              <pre id="output" class="result">Load a skill manifest to begin.</pre>
            </div>
          </section>
          <script>
            document.querySelectorAll("[data-app-id]").forEach((button) => {{
              button.onclick = async () => {{
                const response = await fetch(`/v1/skills/${{button.dataset.appId}}/manifest`);
                document.querySelector("#manifest").value = JSON.stringify(await response.json(), null, 2);
                document.querySelector("#output").textContent = "Manifest loaded from private skill module.";
              }};
            }});
            document.querySelector("#copy").onclick = async () => {{
              await navigator.clipboard.writeText(document.querySelector("#manifest").value);
              document.querySelector("#output").textContent = "Manifest copied.";
            }};
            document.querySelector("#submit").onclick = async () => {{
              const output = document.querySelector("#output");
              try {{
                const manifest = JSON.parse(document.querySelector("#manifest").value);
                const response = await fetch("http://127.0.0.1:8100/v1/creator/manifests", {{
                  method: "POST",
                  headers: {{"content-type": "application/json"}},
                  body: JSON.stringify(manifest)
                }});
                output.textContent = JSON.stringify(await response.json(), null, 2);
              }} catch (error) {{
                output.textContent = error.stack || error.message;
              }}
            }};
          </script>
        </main>
        </body>
        """

    @app.get("/v1/skills/{app_id}/manifest")
    async def skill_manifest(app_id: str) -> dict[str, Any]:
        return SkillStore().load(app_id).manifest

    @app.websocket("/runtime")
    async def runtime_endpoint(websocket: WebSocket) -> None:
        await _handle_runtime_socket(websocket, make_runtime)

    return app


async def _handle_runtime_socket(websocket: WebSocket, runtime_factory: RuntimeFactory) -> None:
    await websocket.accept()

    send_lock = asyncio.Lock()
    hello: RuntimeHello | None = None
    turn_tasks: set[asyncio.Task[None]] = set()

    async def send_json(payload: dict[str, Any]) -> None:
        async with send_lock:
            await websocket.send_json(payload)

    broker = LocalToolBroker(send_json)

    async def send_message(message: Any) -> None:
        await send_json(dump_message(message))

    async def run_turn(turn: TurnStart) -> None:
        if hello is None:
            raise RuntimeError("runtime.hello is required before turn execution")
        runtime = runtime_factory(hello)
        try:
            async for event in runtime.run_turn(turn, broker):
                await send_message(event)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - exercised through runtime timeout behavior.
            logger.exception("creator runtime turn failed")
            await send_message(
                TurnError(
                    turn_id=turn.turn_id,
                    error={
                        "code": "turn_failed",
                        "message": str(exc),
                    },
                )
            )

    try:
        while True:
            try:
                raw = await websocket.receive_json()
                message = parse_inbound_message(raw)
            except ProtocolError as exc:
                await send_message(
                    RuntimeErrorMessage(
                        error={
                            "code": "protocol_error",
                            "message": str(exc),
                        }
                    )
                )
                continue

            if isinstance(message, RuntimeHello):
                if message.protocol_version != PROTOCOL_VERSION:
                    await send_message(
                        RuntimeErrorMessage(
                            error={
                                "code": "unsupported_protocol_version",
                                "message": (
                                    f"expected protocol_version {PROTOCOL_VERSION}, "
                                    f"got {message.protocol_version}"
                                ),
                            }
                        )
                    )
                    continue
                hello = message
                await send_message(
                    RuntimeReady(
                        app_id=message.app_id,
                        accepted_protocol_version=PROTOCOL_VERSION,
                    )
                )
                continue

            if hello is None:
                await send_message(
                    RuntimeErrorMessage(
                        error={
                            "code": "hello_required",
                            "message": "runtime.hello must be sent before turn messages",
                        }
                    )
                )
                continue

            if isinstance(message, TurnStart):
                task = asyncio.create_task(run_turn(message))
                turn_tasks.add(task)
                task.add_done_callback(turn_tasks.discard)
                continue

            if isinstance(message, ToolResult):
                handled = await broker.handle_tool_result(message)
                if not handled:
                    await send_message(
                        RuntimeErrorMessage(
                            error={
                                "code": "unknown_tool_call",
                                "message": f"no pending tool request for {message.tool_call_id}",
                            }
                        )
                    )
                continue
    except WebSocketDisconnect:
        pass
    finally:
        broker.cancel_pending()
        for task in turn_tasks:
            task.cancel()
        if turn_tasks:
            await asyncio.gather(*turn_tasks, return_exceptions=True)


app = create_app()


def main() -> None:
    uvicorn.run(
        "hatch_creator_server.app:app",
        host="127.0.0.1",
        port=8200,
        reload=False,
    )


def creator_styles() -> str:
    return """
    <style>
      :root {
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f7f7f5;
        color: #18211d;
      }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: #f7f7f5; }
      a { color: inherit; text-decoration: none; }
      .topbar {
        align-items: center;
        border-bottom: 1px solid #dadfd8;
        display: flex;
        justify-content: space-between;
        padding: 16px 28px;
      }
      .brand { align-items: center; display: flex; gap: 10px; }
      .mark {
        align-items: center;
        background: #18211d;
        border-radius: 8px;
        color: white;
        display: inline-flex;
        height: 34px;
        justify-content: center;
        width: 34px;
      }
      nav { color: #5e6963; display: flex; font-size: 14px; gap: 18px; }
      .page { margin: 0 auto; max-width: 1180px; padding: 34px 28px 56px; }
      .hero {
        display: grid;
        gap: 24px;
        grid-template-columns: minmax(0, 1fr) 340px;
        margin-bottom: 28px;
      }
      h1 { font-size: clamp(34px, 5vw, 60px); letter-spacing: 0; line-height: 1.02; margin: 8px 0 14px; }
      h2 { font-size: 20px; margin: 0; }
      p { margin: 0; }
      .lead { color: #5e6963; font-size: 17px; line-height: 1.55; max-width: 760px; }
      .eyebrow { color: #6f7a74; font-size: 12px; font-weight: 800; letter-spacing: 0; text-transform: uppercase; }
      code, .badge {
        background: #edf1ee;
        border: 1px solid #d8dfd9;
        border-radius: 999px;
        color: #3d4943;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        padding: 3px 8px;
      }
      .status-panel {
        background: #18211d;
        border-radius: 8px;
        color: white;
        display: grid;
        overflow: hidden;
      }
      .status-panel div { background: rgba(255,255,255,.07); border-bottom: 1px solid rgba(255,255,255,.08); display: grid; gap: 6px; padding: 22px; }
      .status-panel span { color: #c9d2cc; font-size: 13px; }
      .status-panel strong { font-size: 19px; }
      .workspace { display: grid; gap: 18px; grid-template-columns: 420px minmax(0, 1fr); }
      .skills, .manifest-panel {
        background: white;
        border: 1px solid #d8dfd9;
        border-radius: 8px;
        padding: 18px;
      }
      .section-head, .panel-head { align-items: center; display: flex; justify-content: space-between; margin-bottom: 14px; }
      .skill-list { display: grid; gap: 12px; }
      .skill-card {
        align-items: center;
        border: 1px solid #d8dfd9;
        border-radius: 8px;
        display: grid;
        gap: 12px;
        grid-template-columns: 48px minmax(0, 1fr);
        padding: 12px;
      }
      .skill-card button { grid-column: 1 / -1; }
      .skill-icon {
        align-items: center;
        background: #e5ebe7;
        border-radius: 8px;
        display: flex;
        font-weight: 800;
        height: 48px;
        justify-content: center;
        width: 48px;
      }
      .skill-card p:not(.eyebrow) { color: #5e6963; font-size: 13px; line-height: 1.45; margin-top: 4px; }
      textarea {
        border: 1px solid #cbd2cc;
        border-radius: 8px;
        font: 13px ui-monospace, SFMono-Regular, Menlo, monospace;
        height: 430px;
        line-height: 1.45;
        padding: 12px;
        resize: vertical;
        width: 100%;
      }
      .actions { display: flex; gap: 10px; margin-top: 12px; }
      .primary, button.primary {
        background: #18211d;
        border: 1px solid #18211d;
        border-radius: 6px;
        color: white;
        cursor: pointer;
        font: inherit;
        min-height: 38px;
        padding: 0 14px;
      }
      .ghost, button.ghost {
        background: white;
        border: 1px solid #cbd2cc;
        border-radius: 6px;
        color: #18211d;
        cursor: pointer;
        font: inherit;
        min-height: 38px;
        padding: 8px 12px;
      }
      .result {
        background: #111614;
        border-radius: 8px;
        color: #e9eee9;
        font-size: 12px;
        line-height: 1.5;
        margin: 12px 0 0;
        min-height: 120px;
        overflow: auto;
        padding: 12px;
        white-space: pre-wrap;
      }
      @media (max-width: 860px) {
        .hero, .workspace { grid-template-columns: 1fr; }
        .topbar { align-items: flex-start; flex-direction: column; gap: 12px; }
      }
    </style>
    """
