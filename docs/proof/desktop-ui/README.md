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
it does not prove cloud Conversation Library hydration or durable Run recovery.
Dynamic-window restart restoration is covered separately by a native-owned
app-data manifest and a clean-quit UAT; crash/reload recovery of the renderer
and cloud Run remains an external row in the acceptance matrix.

On 2026-08-11 macOS UAT, a uniquely named preview bundle opened the primary
window plus two `Hatch — Conversation` windows. The accessibility tree exposed
different `conv_preview_*` URLs in each window. Closing the front window
revealed the second window; closing that one returned to the primary window.
A screenshot was captured during this run; it is intentionally not checked in
as a product fixture because the generated IDs are ephemeral.

The same uniquely named preview then executed a restart loop. Two server-shaped
`conv_preview_*` windows were opened, `conversation-windows.json` contained
both IDs, `Cmd-Q` preserved the manifest, and the next launch restored a
`Hatch — Conversation` window. Closing the front restored window exposed the
other conversation; the manifest then contained only the surviving ID. This
proves native manifest persistence, normal-quit restore, stable labels and
per-window close cleanup. It does not claim crash recovery of an in-flight
renderer or Run.

The rebuilt preview now subscribes to the same semantic native-command bridge
as the signed-in shell. In a fresh process, the macOS View menu was opened,
`Hide Sidebar` was selected, and the accessibility tree then exposed the
conversation surface without the source list and a `Show sidebar` toolbar
control. Reopening View immediately changed the native item to `Show Sidebar`.
This proves the full native-menu → semantic event → pane state → native-menu
label loop, rather than only proving that a popup can be displayed. The
resulting capture is checked in as
`native-menu-sidebar-collapsed-1180x780.jpeg`.

| Capture | What it proves |
| --- | --- |
| `regular-1180x780.png` | Native traffic lights, integrated titlebar/toolbar, source-list sidebar, conversation surface, inspector |
| `compact-860x600.png` | Inspector collapses before sidebar; main conversation remains in document flow |
| `minimal-640x600.png` | Main surface remains usable at the configured minimum; side panes are off-canvas |
| `minimal-sidebar-overlay.png` | Sidebar opens as a focus-scoped overlay and returns focus to its opener |
| `minimal-inspector-overlay.png` | Inspector opens as a focus-scoped trailing overlay and closes with Escape |
| `native-menu-sidebar-collapsed-1180x780.jpeg` | Native View → Hide Sidebar changes the live pane and the next View menu says Show Sidebar |
| `zoom-80-1180x780.jpeg` | 80% application zoom keeps all three panes, toolbar, table and composer reachable |
| `zoom-150-1180x780.jpeg` | 150% application zoom promotes the conversation surface while keeping Send and structured content usable |
| `zoom-200-table-overflow-1180x780.jpeg` | 200% application zoom collapses side panes and leaves table overflow local to its wrapper |
| `final-sign-in-1180x780.jpeg` | Final release `.app` launch shows the ordinary Sign in surface without a Login Keychain unlock prompt |

## Automated evidence recorded with these captures

- Renderer: 22 files / 94 tests
- Rust Tauri library: 44 passed / 1 ignored (unlocked Keychain smoke)
- Runtime: 226 Node subtests passed with an isolated `HATCH_RUNTIME_DATA_DIR`
- LocalRunner: 43 tests passed (filesystem, shell and macOS Seatbelt suites)
- `npm run build:web` (latest recovery-hardening bundle)

## Desktop-native visual review

The captures are reviewed against the behavior users normally associate with a
desktop application, rather than against a pixel-perfect macOS imitation:

- **Pass on macOS preview:** the system traffic lights remain native; the
  title/toolbar is one chrome band; panes use source-list rows, separators and
  selection rather than stacked web cards; the main conversation keeps its
  width while Inspector and Sidebar collapse discretely.
- **Pass on the interaction model:** regular → compact → minimal is a small
  state machine, not a mobile breakpoint; compact panes overlay the document,
  the Composer remains outside the conversation scroller, and overflow is a
  native menu shared with application and context commands.
- **Pass on content behavior:** tables, code and logs retain their structure
  and scroll locally; long titles use ellipsis; the window itself does not
  become a horizontally scrolling webpage. The 200% capture is the strongest
  visual check of this contract.
- **Intentionally WebView-owned:** transcript, Markdown, tool timeline and
  Composer remain React content. This is the chosen Tauri Hybrid boundary, not
  an accidental browser fallback.
- **Still external:** Windows caption/menu metrics, Narrator, Snap/DPI,
  VoiceOver/IME, real Finder/Explorer drag/drop, and signed/notarized release
  behavior require the target-platform UAT listed in the acceptance matrix.
- `npm run build:app` (release `.app`, ad-hoc/UAT; not a publishable notarized artifact)
- `npm run build` (strict ad-hoc/UAT DMG verification; not a publishable notarized artifact)

The native menu was also exercised against the built `.app`: View exposes
dynamic Hide/Show Sidebar and Hide/Show Inspector labels, plus Zoom In, Zoom
Out, Actual Size, and Enter Full Screen; Settings and About open as independent
native auxiliary windows. The latest rebuilt release `.app` was cold-launched after
recovery hardening; its accessibility tree and screenshot showed the ordinary Sign in
screen without a Login Keychain unlock prompt. Persistent Keychain access remains restricted to
the separately configured Developer ID distribution lane. Workspace picker
calls are parented to the invoking window, and artifact Reveal and Quick
Look/Open accept only a grant ID plus a workspace-relative path; Rust re-checks
canonical containment before opening Finder/Explorer or handing the path to the
platform opener. On macOS, a fresh preview UAT opened the artifact context
popup and its accessibility tree exposed `Reveal in Finder`, `Quick Look`, and
`Copy Path`; the popup route carried the semantic `artifact.quickLook` command.
Windows ShellExecute and a valid-grant invocation remain real-platform
acceptance items.

The preview fixture also routes Zoom In, Zoom Out and Actual Size through the
same native semantic command bridge and WebView zoom API as the signed-in
shell. A fresh `Hatch Preview Zoom` bundle was exercised at 80%, 150% and
200%. At 200%, the source list and inspector collapsed instead of squeezing
the conversation into a mobile stack; the long table exposed only its own
horizontal scroll region while the composer and Send action remained fixed.

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
window-scoped opaque handle and display-name chip. Rust reads an immutable,
bounded UTF-8 snapshot at the drop gesture and never stores the path for a
later renderer read. On Send, the renderer sends a protocol `0.7`
`message.attachments` projection (metadata, bounded text, SHA-256 and
truncation); Runtime validates it, records metadata in the journal, and adds
an explicit untrusted framing block only for model input. Binary, invalid
UTF-8 and oversized files never cross the bridge as raw bytes.

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
accessibility, signed release verification, and a valid-grant Quick Look/Open
invocation on each target OS. Finder/Explorer Reveal, the macOS Quick Look
menu route, non-modal window attention, and independent Settings/About
auxiliary windows are now covered by the native bridge.
