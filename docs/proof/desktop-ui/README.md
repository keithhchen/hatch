# Desktop UI UAT evidence

These captures are macOS UAT evidence for the Tauri Hybrid shell. They are
not a substitute for Windows, VoiceOver, Narrator, signed-package, DPI, IME,
or multi-monitor acceptance.

For the requirement-by-requirement status and explicit evidence boundaries, see
[acceptance-matrix.md](acceptance-matrix.md).

The regular/compact/minimal captures use the development-only `DesktopPreview`
fixture and an environment-selected native window size, so the shell can be
exercised without an account. There are no in-page tier controls: the preview
calls the Tauri window sizing API, then the same `ResizeObserver`/native resize
path drives the production shell's layout tier. These captures prove pane
composition and structured-content behavior, not cloud Conversation or Run
persistence. The final sign-in capture is from the built ad-hoc `.app`.

The clean capture commands are:

```text
VITE_HATCH_DESKTOP_PREVIEW=1 VITE_HATCH_DESKTOP_PREVIEW_TIER=regular \
  npx tauri build --debug --bundles app --config '{"identifier":"dev.hatch.preview"}'
VITE_HATCH_DESKTOP_PREVIEW=1 VITE_HATCH_DESKTOP_PREVIEW_TIER=compact \
  npx tauri build --debug --bundles app --config '{"identifier":"dev.hatch.preview"}'
VITE_HATCH_DESKTOP_PREVIEW=1 VITE_HATCH_DESKTOP_PREVIEW_TIER=minimal \
  npx tauri build --debug --bundles app --config '{"identifier":"dev.hatch.preview"}'
```

The preview flag is opt-in and is not set by normal development, release, or
distribution builds.

The preview's `New window` action calls the same native
`open_conversation_window` command used by the signed-in shell, with a
bounded `conv_preview_*` identifier. It therefore exercises real Tauri
conversation-window creation, native title-bar ownership, focus routing, and
close lifecycle without requiring an account. This is lifecycle evidence only:
it does not prove cloud Conversation Library hydration, durable Run recovery,
or crash/restart restoration. The latter remain covered by the runtime/native
tests and the external rows in the acceptance matrix.

| Capture | What it proves |
| --- | --- |
| `regular-1180x780.png` | Native traffic lights, integrated titlebar/toolbar, source-list sidebar, conversation surface, inspector |
| `compact-860x600.png` | Inspector collapses before sidebar; main conversation remains in document flow |
| `minimal-640x600.png` | Main surface remains usable at the configured minimum; side panes are off-canvas |
| `minimal-sidebar-overlay.png` | Sidebar opens as a focus-scoped overlay and returns focus to its opener |
| `minimal-inspector-overlay.png` | Inspector opens as a focus-scoped trailing overlay and closes with Escape |
| `final-sign-in-1180x780.jpeg` | Final release `.app` launch shows the ordinary Sign in surface without a Login Keychain unlock prompt |

## Automated evidence recorded with these captures

- Renderer: 21 files / 84 tests
- Rust Tauri library: 37 passed / 1 ignored (unlocked Keychain smoke)
- Runtime: 226 Node subtests passed with an isolated `HATCH_RUNTIME_DATA_DIR`
- LocalRunner: 43 tests passed (filesystem, shell and macOS Seatbelt suites)
- `npm run build:web`
- `npm run build:app` (release `.app`, ad-hoc/UAT; not a publishable notarized artifact)
- `npm run build` (strict ad-hoc/UAT DMG verification; not a publishable notarized artifact)

The native menu was also exercised against the built `.app`: View exposes
Show Sidebar, Show Inspector, Zoom In, Zoom Out, Actual Size, and Enter Full
Screen; Settings and About open as independent native auxiliary windows. The
release build displayed the ordinary Sign in screen without a
Login Keychain unlock prompt; persistent Keychain access remains restricted to
the separately configured Developer ID distribution lane. Workspace picker
calls are parented to the invoking window, and artifact Reveal accepts only a
grant ID plus a workspace-relative path; Rust re-checks canonical containment
before opening Finder/Explorer.

The product window disables WebKit devtools in its Tauri window configuration.
On the rebuilt ad-hoc app, a product-area secondary click therefore did not
expose `Inspect Element`; the live renderer's conversation/tool/artifact rows
route their DOM `contextmenu` events to the semantic Tauri popup, while text
inputs retain the operating-system editing menu. The browser/Vite preview is
still the place to inspect HTML during development.

The rebuilt native preview also exercised a conversation-row secondary click;
the accessibility tree exposed `Rename Conversation`, `Open in New Window`,
and `Archive Conversation` from the Tauri popup rather than a WebKit menu.

File drops now remain native-authoritative: a dropped file produces only a
window-scoped opaque handle and display-name chip. On Send, Rust revalidates
and reads a bounded UTF-8 snapshot once; the renderer projects it into an
explicit untrusted `<attached_context>` block and never receives the absolute
path. Binary and oversized files produce a bounded explanation instead of
raw bytes.

The macOS accessibility tree additionally confirmed that a minimal overlay
removes the hidden pane from the main tree, focuses its close action on open,
and returns focus to the toolbar toggle after Escape. Window app-data now
stores `composerDraft` and `viewport scrollTop` separately from the workspace
onboarding draft, and binds the context to the signed-in account, so a
close/reopen does not discard unfinished input or the reading position while a
sign-out/sign-in transition cannot leak it across accounts (the persistence path
is covered by renderer/native settings tests; a full crash/restart proof still
belongs to P4).

## Native UX judgment

The regular/compact/minimal transitions preserve a desktop task hierarchy:
panes collapse discretely, the main task surface is never stacked below the
sidebar, and transient overlays own focus. The shell is intentionally not a
pixel clone of AppKit: Tauri owns the native window/menu boundary while React
owns transcript, Markdown, code, tables, tool activity, and composer content.

The remaining platform work is explicit in the parent spec: Windows UAT and
accessibility, signed release verification, and a true Quick Look/Open parity
surface. Finder/Explorer Reveal, non-modal window attention, and independent
Settings/About auxiliary windows are now covered by the native bridge.
