# Desktop UI UAT evidence

These captures are macOS UAT evidence for the Tauri Hybrid shell. They are
not a substitute for Windows, VoiceOver, Narrator, signed-package, DPI, IME,
or multi-monitor acceptance.

The regular/compact/minimal captures use the development-only `DesktopPreview`
fixture and a sizing harness so the shell can be exercised without an account;
they prove pane composition and structured-content behavior, not cloud
Conversation or Run persistence. The final sign-in capture is from the built
ad-hoc `.app`.

| Capture | What it proves |
| --- | --- |
| `regular-1180x780.png` | Native traffic lights, integrated titlebar/toolbar, source-list sidebar, conversation surface, inspector |
| `compact-860x600.png` | Inspector collapses before sidebar; main conversation remains in document flow |
| `minimal-640x600.png` | Main surface remains usable at the configured minimum; side panes are off-canvas |
| `minimal-sidebar-overlay.png` | Sidebar opens as a focus-scoped overlay and returns focus to its opener |
| `minimal-inspector-overlay.png` | Inspector opens as a focus-scoped trailing overlay and closes with Escape |
| `final-sign-in-1180x780.jpeg` | Final release `.app` launch shows the ordinary Sign in surface without a Login Keychain unlock prompt |

## Automated evidence recorded with these captures

- Renderer: 19 files / 80 tests
- Rust Tauri library: 34 passed / 1 ignored (unlocked Keychain smoke)
- Runtime: 225 Node subtests passed with an isolated `HATCH_RUNTIME_DATA_DIR`
- LocalRunner: 43 tests passed (filesystem, shell and macOS Seatbelt suites)
- `npm run build:web`
- `npm run build:app` (release `.app`, ad-hoc/UAT; not a publishable notarized artifact)

The native menu was also exercised against the built `.app`: View exposes
Show Sidebar, Show Inspector, Zoom In, Zoom Out, Actual Size, and Enter Full
Screen; Settings and About open as independent native auxiliary windows. The
release build displayed the ordinary Sign in screen without a
Login Keychain unlock prompt; persistent Keychain access remains restricted to
the separately configured Developer ID distribution lane. Workspace picker
calls are parented to the invoking window, and artifact Reveal accepts only a
grant ID plus a workspace-relative path; Rust re-checks canonical containment
before opening Finder/Explorer.

The macOS accessibility tree additionally confirmed that a minimal overlay
removes the hidden pane from the main tree, focuses its close action on open,
and returns focus to the toolbar toggle after Escape. Window app-data now
stores `composerDraft` and `viewport scrollTop` separately from the workspace
onboarding draft, so a close/reopen does not discard unfinished input or the
reading position (the persistence path is covered by renderer/native settings
tests; a full crash/restart proof still belongs to P4).

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
