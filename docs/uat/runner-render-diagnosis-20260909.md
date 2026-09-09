# Runner rendering diagnostic — incomplete

Expanded source-Skill real-runner integration now covers DOCX, PPTX and XLSX rendering plus XLSX recalculation. Recalculation exposed unnecessary `shutil.copy2` flags preservation denied by the private scratch policy; replaced both staging/output copies with byte-only `copyfile` and created the private profile before invocation. No permission relaxation for flags. `/tmp/hatch-runner-office-recalc-content-copy-20260909.log` passed: actual PDF/PNG outputs, formula preserved as `=A1+8`, cached result 50, original workbook cache unchanged. Removed the obsolete VCL diagnostic environment switch from the integration test. This remains macOS source-Skill integration, not Windows execution, fresh-package UAT, or visual layout QA.

**Implementation now succeeds for DOCX source-Skill integration:** shared `run_libreoffice` sets private-profile cwd and POSIX `OSL_SOCKET_PATH=.`, all five calling scripts pass absolute source/output arguments, and Runner policy grants only SCRATCH Unix sockets plus the four named AppKit services. `HATCH_TEST_SOURCE_SKILLS=1 HATCH_TEST_RUNTIME_ROOT=/Applications/Hatch.app/Contents/Resources/runtime cargo test --manifest-path local-runner/Cargo.toml --test shell_sandbox_macos bundled_document_render_runs_inside_runner_sandbox -- --ignored --nocapture` passed in 4.52s (`/tmp/hatch-runner-shared-helper-render-20260909.log`). Source mode copies the real repository skills into the test workspace and is explicitly NOT installed-package UAT; default test still uses installed/built skills. Three helper/error-contract tests passed. Production source changes are now retained, unlike earlier experiments. PPTX/XLSX/legacy conversions, visual inspection, broader service-boundary review, and freshly packaged GUI/OS UAT remain outstanding.

**Working confined-render diagnostic found:** allowing the four named AppKit services plus Unix socket operations scoped to Runner **SCRATCH only**, running conversion from that private directory with `OSL_SOCKET_PATH=.`, and passing absolute source/output paths produced PDF and PNG in 3.92s (`/tmp/hatch-runner-private-ipc-render-20260909.log`). All 13 existing sandbox security tests then passed (`/tmp/hatch-runner-private-ipc-security-20260909.log`). Earlier WORKSPACE-scoped IPC also rendered but correctly failed the existing workspace-listener denial test; it was narrowed, not accepted and not hidden by changing the test. Temporary policy grants and test command rewrites are now reverted. Production implementation must move this directory/IPC setup into the shared conversion helper and use the narrowly scoped policy, then verify each document script and permission boundary. This is fixed-fixture real-runner integration evidence, not installed-GUI UAT or visual content review.

IPC root cause narrowed further: bounded kernel query for 13:30:25–13:30:30 reports `file-write-create /OSL_PIPE_501_SingleOfficeIPC_*`. Matching upstream `sal/osl/unx/pipe.cxx` (https://raw.githubusercontent.com/LibreOffice/core/libreoffice-26.2.5.2/sal/osl/unx/pipe.cxx) selects `/tmp`, then `/var/tmp`, then bootstrap `OSL_SOCKET_PATH`; neither global temp directory is writable in this policy. Diagnostic `OSL_SOCKET_PATH=.` moved the socket into the test workspace, confirmed by the next kernel query (13:32:15–13:32:36), which now reports **network-bind to that workspace OSL_PIPE path**. Conversion still failed in 1.73s (`/tmp/hatch-runner-osl-socket-20260909.log`). Both diagnostic environment prefix and service grants were reverted. Next targeted experiment is filesystem-scoped Unix socket bind/connect permissions inside the per-call authorized directory, not general network access. The earlier long-running log query was cancelled; bounded queries completed successfully.

Direct-command follow-up (`/tmp/hatch-runner-conversion-stdout-20260909.log`): after the same script failure, invoked bundled soffice directly with absolute `$PWD/probe.docx` and `$PWD/rendered` paths under the four-service diagnostic policy. It emitted no additional stdout/stderr; the whole test still failed (the diagnostic deliberately exits 1 after the fallback, so that status is not the soffice status). This does not prove successful output or isolate the cause to relative paths. Both temporary grants and fallback command were reverted. No matching headless soffice process remained in the post-test process check. System-log query remains live in exec session 64954.

Second scoped service diagnostic (`/tmp/hatch-runner-appkit-services-20260909.log`): temporarily allowed exactly LaunchServices, windowmanager.server, windowserver.active, and ViewBridgeAuxiliary for the fixed test fixture. Test completed in 2.04 seconds rather than stalling; installed render script reported `LibreOffice did not produce rendered/probe.pdf` (the script reaches this branch only after a zero LibreOffice exit code). No PDF/PNG success. All four temporary grants were immediately removed from source. Next diagnostic should capture conversion stdout/stderr and check relative-path resolution/file access; do not re-run the same SVP experiment or assume IPC grants alone finish rendering. System-log query for this attempt was started separately.

Follow-up diagnostic: explicitly selecting `SAL_USE_VCLPLUGIN=svp` inside the same confined shell did not fix conversion. Reproduction adds `HATCH_TEST_VCL_PLUGIN=svp` to the command below. `/tmp/hatch-runner-svp-20260909.log`: real installed-runtime test failed in 1.23 seconds, `conversion_failed`, shell exit 2, not timed out, no PDF/PNG success. The installed script still emits the old generic error. This rules out treating the environment selection alone as a verified fix; it does not by itself prove which plugin was loaded. Production sandbox and runtime environment were not relaxed.

Crash-report follow-up: `/Users/keithchen/Library/Logs/DiagnosticReports/soffice-2026-09-09-131632.ips` from that explicit-SVP run still contains `create_SalInstance → NSApplication sharedApplication → _RegisterApplication → abort`. Thus that particular installed engine invocation still initialized AppKit despite the setting. Stop treating `SAL_USE_VCLPLUGIN=svp` as a sufficient solution for this bundle. A working fix must change the engine build or provide a deliberately confined native conversion path with verified system-service access; broad shell service permissions remain unproven and are not enabled.

Real installed runtime: `/Applications/Hatch.app/Contents/Resources/runtime` (0.1.26).
Execution host: macOS. Harness: current LocalRunner library integration test, **not GUI/OS UAT**.

Reproduce:

```sh
HATCH_TEST_RUNTIME_ROOT=/Applications/Hatch.app/Contents/Resources/runtime cargo test --manifest-path local-runner/Cargo.toml --test shell_sandbox_macos bundled_document_render_runs_inside_runner_sandbox -- --ignored --nocapture
```

The test creates a test-only DOCX using bundled Python, calls the installed documents render script under the real Runner Seatbelt policy, and requires PDF plus actual PNG bytes.

Observed failures:

1. Existing policy: wrapper reports `dirname: command not found` despite the system directories being on PATH.
2. Adding read access for OS-owned executable directories resolves command lookup; wrapper then reports `cd: .../runtime/native/bin: Not a directory`.
3. Diagnostic global metadata permission gets past directory resolution but LibreOffice still fails. That global permission was **removed**, not accepted as a fix.

Follow-up: scoped metadata grants for the exact ancestors of workspace/scratch/runtime/attachments now resolve traversal. Paths are supplied through Seatbelt parameters, not interpolated into policy text. No global metadata permission is retained. All 13 existing macOS sandbox regression tests pass after this change.

Direct conversion now reveals exit 134 (`SIGABRT`). The installed LibreOffice 26.2.5.2 crash report `soffice-2026-09-09-123051.000.ips` shows `_RegisterApplication → NSApplication sharedApplication → create_SalInstance → InitVCL` on its crashing main thread, even with `--headless`. The bundled macOS engine contains `libvclplug_osxlo.dylib`; no separate svp plugin was found. This is concrete evidence of AppKit application initialization, not a missing Python package. The precise required system-service capability is not yet proven.

Rendering remains failing. Next: diagnose the minimum system service requirements or a confined conversion execution architecture; preserve credential/network/process isolation and verify again. Do not claim dependency availability or rendering success from version/import checks. The regression is opt-in because a complete real runtime is required, and was explicitly run and failed—not counted as passing via ignore.

Separately verified: cloud deployment run 34310581092 completed successfully; production runtime image is `061bf8578063068af162846225273041bf11effa`, with `HATCH_OUTPUT_GUARD=off`. Desktop CI 34310450829 was still running at inspection; no new release completion claim.

Further corrections (not yet released):

- Exact macOS logs at 12:30:51 establish `mach-lookup com.apple.coreservices.launchservicesd` denied, followed by `_RegisterApplication(), unable to get application ASN from launchservicesd ... aborting`.
- A temporary local diagnostic allow for only that service prevented immediate abort but left conversion stalled in `AquaSalInstance::SVMainHook → NSApplicationMain → CFRunLoop`. Process sample at 12:36:00 confirmed this; kernel logs also show denied WindowServer/ViewBridge queries. This permission experiment was reverted: **no LaunchServices grant is retained in the Runner**. A general shell grant to application services is not an acceptable assumption merely to get conversions working.

- Official matching-version source confirms SVP requires `ENABLE_HEADLESS`; without it, `--headless` falls back to the platform plugin: https://github.com/LibreOffice/core/blob/libreoffice-26.2.5.2/vcl/source/app/salplug.cxx . Absence of a separate plugin file alone is not proof, because SVP can be compiled into the engine.
- Shared conversion helper now preserves a silent failing process's exit code/signal in its diagnostic.
- DOCX default rendering requires Poppler up front and fails on zero previews; explicit `--pdf-only` remains supported. No silent PDF-only success for a PNG preview request.
- Two error-contract unit tests pass using bundled Python. They are not rendering UAT.
- macOS CI now explicitly executes the real bundled-runtime sandbox rendering test after packaging. This gate is currently expected to fail until the engine/sandbox integration is fixed; it must not be skipped or treated as green through the test's default ignore marker.
# Four-layer regression checkpoint

Revalidated on 2026-09-09 against the current working tree:

- `cargo test --locked --manifest-path local-runner/Cargo.toml`: 47 passed;
  the opt-in bundled-document test was ignored by the default run.
- Explicitly ran that test with
  `HATCH_TEST_RUNTIME_ROOT=/Applications/Hatch.app/Contents/Resources/runtime`
  and `HATCH_TEST_SOURCE_SKILLS=1`: passed in 20.52 seconds. This exercises
  current source scripts through the real macOS Runner with installed Python,
  LibreOffice and Poppler: DOCX/PPTX/XLSX rendering and spreadsheet recalculation.
- This is integration evidence, not a rebuilt installation or GUI/Windows UAT.

Remaining execution-layer issue: the Windows implementation still inherits its
parent environment and does not enforce the directory permissions required by
the spec. PowerShell plus a Job Object is not filesystem isolation. This must be
resolved in code execution, not in document skills or conversion fallbacks.
Upstream inspection located Codex's implementation in
`codex-rs/windows-sandbox-rs` (not `windows-sandbox`); its manifest depends on
several Codex workspace crates and its implementation separates ACL, identity,
token, environment and process handling. It is not a drop-in standalone helper.
