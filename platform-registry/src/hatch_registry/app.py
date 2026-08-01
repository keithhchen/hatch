from __future__ import annotations

from html import escape
import os
from pathlib import Path
import secrets
from typing import Annotated

from fastapi import FastAPI, Header, HTTPException, status
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from hatch_registry.models import (
    AppManifest,
    InstallCreateRequest,
    InstallRecord,
    LatestVersionResponse,
    LicenseVerificationResponse,
    LicenseVerifyRequest,
    ManifestSummary,
    SignedManifest,
    CreatorReleasePublishRequest,
    PublishedCreatorRelease,
)
from hatch_registry.store import RegistryStore
from hatch_registry.release_resolver import ReleaseResolver, ReleaseVerificationError


def create_app(
    store: RegistryStore | None = None,
    publish_service_token: str | None = None,
) -> FastAPI:
    default_root = Path(__file__).resolve().parents[3] / "runtime-releases"
    release_root = Path(os.environ.get("HATCH_CREATOR_RELEASE_ROOT", default_root))
    configured_state_path = os.environ.get("HATCH_REGISTRY_STATE_PATH", "").strip()
    state_path = Path(configured_state_path).expanduser() if configured_state_path else None
    registry_store = store or RegistryStore.seeded(
        release_resolver=ReleaseResolver(release_root),
        state_path=state_path,
    )
    token_source = (
        os.environ.get("HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN", "")
        if publish_service_token is None
        else publish_service_token
    )
    configured_publish_service_token = token_source.strip()

    api = FastAPI(
        title="Hatch Registry",
        version="0.1.0",
        summary="Metadata-only registry service for Hatch MVP app distribution.",
    )
    api.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @api.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @api.get("/", response_class=HTMLResponse)
    def store_home() -> str:
        items = registry_store.list_manifest_summaries()
        rows = "\n".join(
            f"""
            <article class="app-card">
              <div class="app-icon">{escape(item.name[:1].upper())}</div>
              <div>
                <div class="card-topline">
                  <span class="eyebrow">Creator app</span>
                  <code>{escape(item.latest_version)}</code>
                </div>
                <h2>{escape(item.name)}</h2>
                <p>{escape(item.description)}</p>
                <div class="meta">
                  <span>{escape(item.creator_display_name)}</span>
                  <span>{escape(item.app_id)}</span>
                </div>
              </div>
              <a class="ghost" href="/v1/manifests/{escape(item.app_id)}">Manifest</a>
            </article>
            """
            for item in items
        )
        return f"""
        <!doctype html>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Hatch App Store</title>
        {platform_styles()}
        <body>
          <header class="topbar">
            <div class="brand"><span class="mark">H</span><strong>Hatch Store</strong></div>
            <nav>
              <a href="/">Store</a>
              <a href="/developer">Developer Console</a>
              <a href="/docs">API</a>
            </nav>
          </header>
          <main class="page">
            <section class="hero">
              <div>
                <p class="eyebrow">Manifest distribution layer</p>
                <h1>Creator Agents with cloud execution and user-owned local context.</h1>
                <p class="lead">Hatch signs public manifests, manages installs and licenses, and keeps private Creator logic inside the protected Runtime.</p>
              </div>
              <aside class="stats">
                <div><strong>{len(items)}</strong><span>listed apps</span></div>
                <div><strong>0.3</strong><span>protocol</span></div>
                <div><strong>local</strong><span>filesystem owner</span></div>
              </aside>
            </section>
            <section class="section-head">
              <div>
                <p class="eyebrow">Catalog</p>
                <h2>Available Apps</h2>
              </div>
              <a class="primary" href="/developer">Submit Manifest</a>
            </section>
            <section class="grid">{rows}</section>
          </main>
        </body>
        """

    @api.get("/developer", response_class=HTMLResponse)
    def developer_console() -> str:
        return """
        <!doctype html>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Hatch Developer Console</title>
        """ + platform_styles() + """
        <main class="console">
          <header class="console-head">
            <div>
              <p class="eyebrow">Platform developer console</p>
              <h1>Submit a public app manifest</h1>
              <p class="lead">The platform reviews and signs metadata only. Private skill instructions remain inside the protected Runtime.</p>
            </div>
            <a class="ghost" href="/">Back to Store</a>
          </header>
          <section class="console-grid">
            <article class="panel">
              <div class="panel-head">
                <h2>Manifest JSON</h2>
                <span class="badge">public contract</span>
              </div>
              <textarea id="manifest" spellcheck="false" placeholder='Paste the manifest exported by Creator Console'></textarea>
              <div class="actions">
                <button id="submit" class="primary">Submit Manifest</button>
                <button id="sample" class="ghost" type="button">Load Example Shape</button>
              </div>
            </article>
            <aside class="panel">
              <div class="panel-head">
                <h2>Review Surface</h2>
                <span class="badge">platform-owned</span>
              </div>
              <ul class="checklist">
                <li>The published Release resolves to the Hatch Runtime.</li>
                <li>Permissions and local tools are visible before install.</li>
                <li>License policy is signed with the manifest.</li>
                <li>Skill source and hidden instructions are not submitted.</li>
              </ul>
              <pre id="output" class="result">Waiting for manifest...</pre>
            </aside>
          </section>
          <script>
            document.querySelector("#sample").onclick = () => {
              document.querySelector("#manifest").value = JSON.stringify({
                app_id: "app_lorem_creator",
                name: "Lorem Creator App",
                version: "0.1.0",
                description: "Synthetic skill-app that searches and edits the user's local lorem workspace.",
                creator: {
                  creator_id: "creator_lorem",
                  display_name: "Lorem Creator",
                  support_url: "https://support.example.invalid/lorem"
                },
                runtime: {
                  runtime_type: "remote_agent",
                  websocket_url: "ws://127.0.0.1:8400/runtime",
                  protocol_version: "0.3"
                },
                permissions: [
                  { key: "workspace.read", description: "Read synthetic files inside this app's local sandbox." },
                  { key: "workspace.write", description: "Write synthetic outputs inside this app's local sandbox." }
                ],
                license: { policy_id: "license_lorem_subscription", plan: "subscription", trial_days: 0 },
                distribution: { channel: "synthetic", install_size_bytes: 4096, manifest_url: "/v1/manifests/app_lorem_creator" }
              }, null, 2);
            };
            document.querySelector("#submit").onclick = async () => {
              const output = document.querySelector("#output");
              try {
                const manifest = JSON.parse(document.querySelector("#manifest").value);
                const response = await fetch("/v1/creator/manifests", {
                  method: "POST",
                  headers: {"content-type": "application/json"},
                  body: JSON.stringify(manifest)
                });
                output.textContent = JSON.stringify(await response.json(), null, 2);
              } catch (error) {
                output.textContent = error.stack || error.message;
              }
            };
          </script>
        </main>
        """

    @api.get("/v1/manifests", response_model=list[ManifestSummary])
    def list_manifests() -> list[ManifestSummary]:
        return registry_store.list_manifest_summaries()

    @api.get("/v1/manifests/{app_id}", response_model=SignedManifest)
    def get_manifest(app_id: str) -> SignedManifest:
        manifest = registry_store.get_latest_manifest(app_id)
        if manifest is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"manifest not found for app_id={app_id}",
            )
        return manifest

    @api.post(
        "/v1/creator/manifests",
        response_model=SignedManifest,
        status_code=status.HTTP_201_CREATED,
    )
    def submit_manifest(manifest: AppManifest) -> SignedManifest:
        return registry_store.submit_manifest(manifest)

    @api.get("/v1/apps/{app_id}/latest", response_model=LatestVersionResponse)
    def latest_version(app_id: str) -> LatestVersionResponse:
        latest = registry_store.get_latest_version(app_id)
        if latest is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"latest version not found for app_id={app_id}",
            )
        return latest

    @api.post(
        "/v1/installs",
        response_model=InstallRecord,
        status_code=status.HTTP_201_CREATED,
    )
    def create_install(request: InstallCreateRequest) -> InstallRecord:
        try:
            return registry_store.create_install(request)
        except LookupError as exc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=str(exc),
            ) from exc

    @api.post("/v1/licenses/verify", response_model=LicenseVerificationResponse)
    def verify_license(request: LicenseVerifyRequest) -> LicenseVerificationResponse:
        if not registry_store.has_app(request.app_id):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"app not found for app_id={request.app_id}",
            )
        return registry_store.verify_license(request)

    @api.post(
        "/v1/creator/releases",
        response_model=PublishedCreatorRelease,
        status_code=status.HTTP_201_CREATED,
    )
    def publish_creator_release(
        request: CreatorReleasePublishRequest,
        authorization: Annotated[str | None, Header()] = None,
        creator_id: Annotated[str | None, Header(alias="X-Hatch-Creator-Id")] = None,
    ) -> PublishedCreatorRelease:
        authenticated_creator_id = require_creator_publish_auth(
            authorization,
            creator_id,
            configured_publish_service_token,
        )
        try:
            return registry_store.publish_creator_release(
                request,
                creator_id=authenticated_creator_id,
            )
        except PermissionError as exc:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=str(exc),
            ) from exc
        except ReleaseVerificationError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=str(exc),
            ) from exc
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=str(exc),
            ) from exc

    @api.get(
        "/v1/creator/{creator_id}/releases",
        response_model=list[PublishedCreatorRelease],
    )
    def list_creator_releases(creator_id: str) -> list[PublishedCreatorRelease]:
        return registry_store.list_creator_releases(creator_id)

    @api.get(
        "/v1/creator-releases/{release_id:path}",
        response_model=PublishedCreatorRelease,
    )
    def get_creator_release(release_id: str) -> PublishedCreatorRelease:
        release = registry_store.get_creator_release(release_id)
        if release is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"creator release not found for release_id={release_id}",
            )
        return release

    return api


def require_creator_publish_auth(
    authorization: str | None,
    creator_id: str | None,
    configured_service_token: str,
) -> str:
    if not configured_service_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Creator Release publishing is not configured.",
        )
    scheme, _, supplied_token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not supplied_token or not secrets.compare_digest(
        supplied_token,
        configured_service_token,
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="A valid Registry publish service token is required.",
        )
    normalized_creator_id = (creator_id or "").strip()
    if not normalized_creator_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-Hatch-Creator-Id is required.",
        )
    return normalized_creator_id


app = create_app()


def main() -> None:
    uvicorn.run("hatch_registry.app:app", host="127.0.0.1", port=8100, reload=False)


def platform_styles() -> str:
    return """
    <style>
      :root {
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f7f4;
        color: #17201c;
      }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: #f6f7f4; }
      a { color: inherit; text-decoration: none; }
      .topbar {
        align-items: center;
        border-bottom: 1px solid #d9ded6;
        display: flex;
        justify-content: space-between;
        padding: 16px 28px;
      }
      .brand { align-items: center; display: flex; gap: 10px; }
      .mark {
        align-items: center;
        background: #17201c;
        border-radius: 8px;
        color: white;
        display: inline-flex;
        height: 34px;
        justify-content: center;
        width: 34px;
      }
      nav { display: flex; gap: 18px; color: #59645f; font-size: 14px; }
      .page, .console { margin: 0 auto; max-width: 1120px; padding: 34px 28px 56px; }
      .hero {
        align-items: stretch;
        display: grid;
        gap: 24px;
        grid-template-columns: minmax(0, 1fr) 320px;
        margin-bottom: 34px;
      }
      h1 { font-size: clamp(34px, 5vw, 64px); letter-spacing: 0; line-height: 1.02; margin: 8px 0 14px; max-width: 820px; }
      h2 { font-size: 20px; margin: 0; }
      p { margin: 0; }
      .lead { color: #59645f; font-size: 17px; line-height: 1.55; max-width: 680px; }
      .eyebrow { color: #6e7a73; font-size: 12px; font-weight: 700; letter-spacing: 0; text-transform: uppercase; }
      .stats {
        background: #17201c;
        border-radius: 8px;
        color: white;
        display: grid;
        gap: 1px;
        overflow: hidden;
      }
      .stats div { background: rgba(255,255,255,.07); display: grid; gap: 6px; padding: 22px; }
      .stats strong { font-size: 28px; }
      .stats span { color: #c9d2cc; font-size: 13px; }
      .section-head, .console-head {
        align-items: end;
        display: flex;
        justify-content: space-between;
        margin-bottom: 18px;
      }
      .grid { display: grid; gap: 14px; }
      .app-card {
        align-items: center;
        background: white;
        border: 1px solid #d9ded6;
        border-radius: 8px;
        display: grid;
        gap: 16px;
        grid-template-columns: 56px minmax(0, 1fr) auto;
        padding: 16px;
      }
      .app-icon {
        align-items: center;
        background: #e6ece8;
        border-radius: 8px;
        display: flex;
        font-size: 22px;
        font-weight: 800;
        height: 56px;
        justify-content: center;
        width: 56px;
      }
      .card-topline, .meta { align-items: center; display: flex; gap: 10px; }
      .app-card p { color: #59645f; line-height: 1.45; margin: 6px 0 10px; }
      code, .badge {
        background: #edf1ee;
        border: 1px solid #d9ded6;
        border-radius: 999px;
        color: #3f4b45;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        padding: 3px 8px;
      }
      .meta span { color: #6e7a73; font-size: 13px; }
      .primary, button.primary {
        background: #17201c;
        border: 1px solid #17201c;
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
        color: #17201c;
        cursor: pointer;
        font: inherit;
        min-height: 38px;
        padding: 8px 12px;
      }
      .console-grid { display: grid; gap: 18px; grid-template-columns: minmax(0, 1.15fr) minmax(320px, .85fr); }
      .panel {
        background: white;
        border: 1px solid #d9ded6;
        border-radius: 8px;
        padding: 18px;
      }
      .panel-head { align-items: center; display: flex; justify-content: space-between; margin-bottom: 14px; }
      textarea {
        border: 1px solid #cbd2cc;
        border-radius: 8px;
        font: 13px ui-monospace, SFMono-Regular, Menlo, monospace;
        height: 410px;
        line-height: 1.45;
        padding: 12px;
        resize: vertical;
        width: 100%;
      }
      .actions { display: flex; gap: 10px; margin-top: 12px; }
      .checklist { color: #3f4b45; display: grid; gap: 12px; line-height: 1.45; margin: 0 0 18px; padding-left: 20px; }
      .result {
        background: #111614;
        border-radius: 8px;
        color: #e9eee9;
        font-size: 12px;
        line-height: 1.5;
        min-height: 220px;
        overflow: auto;
        padding: 12px;
        white-space: pre-wrap;
      }
      @media (max-width: 760px) {
        .hero, .console-grid { grid-template-columns: 1fr; }
        .app-card { grid-template-columns: 48px minmax(0, 1fr); }
        .app-card .ghost { grid-column: 1 / -1; text-align: center; }
        .section-head, .console-head { align-items: stretch; flex-direction: column; gap: 14px; }
      }
    </style>
    """
