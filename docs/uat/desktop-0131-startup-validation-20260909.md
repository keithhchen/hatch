# Desktop 0.1.31 startup validation — 2026-09-09

## Evidence and limits

- Local `npm run build:app` at source `68685a2c` completed successfully. This command builds the app but does **not** execute `build-dmg.mjs`'s nested signing and bundle verification steps.
- The earlier process blocked the UI thread in `resolve_scoped_workspace_grant → validate_workspace_path → read_dir → __open_nocancel`.
- After moving `ensure_workspace` to a blocking worker, process 63710 responded to accessibility reads in about 0.17 seconds while workspace restoration remained pending. A process sample confirmed the filesystem wait was on Tokio blocking workers rather than the UI thread.
- Terminal directory enumeration of the same Documents folder succeeded. Selecting Documents again through the app's native picker did not complete restoration. These observations do not establish the underlying OS cause.
- `codesign --verify --deep --strict` on the local app failed with `code has no resources but signature indicates they must be present`. The app was exited and further UAT on this artifact stopped. It is not a verified signed UAT package, and its behavior must not be used to declare the complete installation path passed or failed.

## Required follow-up

Use the normal CI DMG, verify its source/size/hash evidence and signature, then repeat startup and document tests. The ARM artifact from run 34342146681 is source `1c8e280d`, so it is a diagnostic comparison only, not evidence for subsequent fixes.

Code inspection separately confirms that workspace restoration gates window readiness and conversation activation. Cloud history loading must be independent of local execution authorization; preserve the authorization checks at execution and avoid overwriting saved grants with initial empty state.

## Automated checks (not OS UAT)

- Renderer after pending-access retry changes: 41 files, 304 tests passed.
- Native library after asynchronous workspace check: 64 tests passed.
- Artifact worker regression harness: 3 tests passed; uses real Tauri dispatch and temporary files, with grant/OS handoff test substitutes.
- LocalRunner after Windows CLI path fix and timeout regression: 6 library tests passed on macOS. Windows rendering and Intel execution require their respective CI jobs.
