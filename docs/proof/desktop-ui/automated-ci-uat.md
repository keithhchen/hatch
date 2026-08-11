# Automated desktop UAT candidates

`Hatch CI` now has a reproducible package-candidate lane on every pull request,
`master` push, and manual `workflow_dispatch` run. It produces two short-lived,
**non-production UAT-only** artifacts:

| Runner | Package | Evidence report |
| --- | --- | --- |
| `macos-latest` | ad-hoc `.app` → `.dmg` | `artifacts/desktop-uat/macos.json` |
| `windows-latest` | debug unsigned NSIS `.exe` | `artifacts/desktop-uat/windows.json` |

The reports are emitted by
[`scripts/uat/record-desktop-uat-artifact.mjs`](../../../scripts/uat/record-desktop-uat-artifact.mjs).
They bind the downloaded package to its SHA-256, source commit, workflow/run
metadata, and the fail-closed `HATCH_PERSISTENT_SESSION=0` configuration. The
script rejects missing, ambiguous, empty, or persistent-session package output.

This makes a CI package a useful input to a target-device UAT: the reviewer can
download a single immutable candidate and verify it before installation. It does
not turn a hosted runner into a substitute for a real macOS or Windows desktop.
Artifacts expire after seven days and must never be published as releases.

## What the automated lanes establish

- The platform runner compiled the package and uploaded exactly the bytes named
  by the report's SHA-256.
- The package lane used process-memory-only session handling; it did not enable
  Keychain, Credential Manager, PasswordVault, or any other persistent token
  store.
- The evidence recorder/verifier is covered by Node tests in the ordinary CI
  renderer job, including SHA mismatch, source mismatch, architecture mismatch,
  and ambiguous-output rejection.
- macOS additionally runs renderer tests/web build, Rust formatting, LocalRunner
  tests, Tauri bridge tests, and strict ad-hoc DMG construction before upload.
- Windows additionally runs renderer tests/web build, LocalRunner tests, Tauri
  bridge tests, and the unsigned NSIS build before upload.

## What remains target-device acceptance

The exact P4 work not claimed by this automation remains:

- install, launch, cold restart, and system integration on the intended macOS
  and Windows versions;
- VoiceOver/Narrator, IME, real Finder/Explorer drag/drop, fullscreen,
  Windows Snap, and multi-display DPI behavior;
- visual resize/zoom cycles and native menu metrics;
- macOS Developer ID, notarization, Gatekeeper, and post-install Keychain
  restart behavior;
- Windows persistent-session work, which remains blocked until the separate
  device-bound security design and same-user negative tests exist.

The requirement-level result remains in the
[acceptance matrix](acceptance-matrix.md); these reports are inputs to that
matrix, not a replacement for its external rows.

## Protected target-device workflow

[`Desktop target-device UAT`](../../../.github/workflows/desktop-target-uat.yml)
is a deliberately manual, protected-workflow skeleton for the next handoff:

1. Copy `source.git_sha` and `package.sha256` from one CI report, together with
   that CI run's numeric ID.
2. Dispatch the workflow for exactly one platform with those three values.
3. The target workflow checks out the source SHA, downloads the named artifact
   from that run, and rejects it unless its report, source SHA, build/target
   architecture, byte count, and SHA-256 all agree.
4. A dedicated interactive self-hosted runner then performs an install-style
   copy/silent install, cold launch, screenshot, and process/log collection.
   The generated evidence is uploaded as a separate 30-day artifact.

Before enabling it, create protected `desktop-uat-macos` and
`desktop-uat-windows` Environments with required reviewers, and provision
dedicated interactive runner pools matching respectively `self-hosted, macos,
arm64` and `self-hosted, windows, x64`; reserve those runners for UAT rather
than co-locating production user data. The UAT accounts must not hold production
user data. The workflow deliberately does not bypass Gatekeeper or SmartScreen:
a block at that point is a UAT result, not an automation failure to work around.

This workflow is not enabled as a release lane and has no signing secrets. The
macOS candidate remains ad-hoc; the Windows candidate remains unsigned. A
notarized/signed release still uses the separate protected release workflow and
requires artifact-level post-install acceptance.

## Local dry run

After creating exactly one package in the corresponding directory, generate the
same evidence format from the repository root:

```text
HATCH_PERSISTENT_SESSION=0 HATCH_GIT_SHA=$(git rev-parse HEAD) \
  node scripts/uat/record-desktop-uat-artifact.mjs \
    --platform macos \
    --artifact-dir desktop-app/src-tauri/target/release/bundle/dmg \
    --output artifacts/desktop-uat/macos.json

HATCH_PERSISTENT_SESSION=0 HATCH_GIT_SHA=$(git rev-parse HEAD) \
  node scripts/uat/record-desktop-uat-artifact.mjs \
    --platform windows \
    --artifact-dir desktop-app/src-tauri/target/debug/bundle/nsis \
    --output artifacts/desktop-uat/windows.json
```

Validate the helper itself with:

```text
node --test scripts/uat/record-desktop-uat-artifact.test.mjs
```

For manual UAT, calculate the package hash again on the target device and check
that it equals `package.sha256` in the downloaded report before recording any
platform evidence.
