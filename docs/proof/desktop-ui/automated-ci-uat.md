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
3. The target workflow checks out the protected default branch's verifier (not
   candidate code), downloads the named artifact from that run, and rejects it
   unless its report, source SHA, build/target architecture, byte count, and
   SHA-256 all agree.
4. A dedicated interactive self-hosted runner then performs an install-style
   copy/silent install, cold launch, screenshot, and process/log collection.
   The generated evidence is uploaded as a separate 30-day artifact.

The candidate process is launched with a minimal credential-free environment:
the macOS lane uses `env -i`, and the Windows lane temporarily strips
GitHub/ACTIONS and credential-like variables before spawning it. This narrows
the UAT runner exposure, but does not make an arbitrary candidate safe to run;
only a dedicated disposable UAT account belongs in that pool.

Before enabling it, create protected `desktop-uat-macos` and
`desktop-uat-windows` Environments with required reviewers, and provision
dedicated interactive runner pools matching respectively `self-hosted, macos,
arm64` and `self-hosted, windows, x64`; reserve those runners for UAT rather
than co-locating production user data. The UAT accounts must not hold production
user data. The workflow deliberately does not bypass Gatekeeper or SmartScreen:
a block at that point is a UAT result, not an automation failure to work around.

This workflow is not enabled as a release lane and has no signing secrets. The
macOS candidate remains ad-hoc; the Windows candidate remains unsigned. A
notarized/signed release uses the separate protected
[`desktop-release.yml`](../../../.github/workflows/desktop-release.yml) lane and
requires artifact-level post-install acceptance. The candidate workflow must
not be used to publish a release.

## Protected signed-release workflow

The signed macOS lane is intentionally a three-stage contract:

1. `build-release` runs only from a `vMAJOR.MINOR.PATCH` tag, checks that
   `HATCH_SIGNED_WORKSPACE_SMOKE_SHA` equals the exact `GITHUB_SHA`, and runs
   the Developer ID build plus notarization/stapling in the protected
   `desktop-production` Environment.
2. After stapling, the job writes
   `release-artifact.json`. It records the source SHA, current workflow run ID,
   tag, filename, byte count, and `sha256:<64 hex digits>` of the final DMG,
   as well as the signed, notarized, persistent-session contract and the
   Developer ID signing identity, Team ID, and bundle identifier. The manifest
   and DMG are uploaded together as one immutable artifact named for the
   workflow run.
3. `release-target-uat` downloads that same artifact, but checks out the
   protected default branch for the verifier. It rejects any source/run/tag/
   hash/provenance mismatch before a dedicated interactive
   `self-hosted, macos, arm64` runner installs and cold-launches the exact DMG.
   `codesign`, Gatekeeper (`spctl`), stapler validation, screenshot, and
   process/log evidence are collected. A required reviewer on
   `desktop-release-uat` must inspect the screenshot and verify the clean
   restart/Keychain, Workspace grant, native menu, resize, and accessibility
   checklist for that exact hash.

Only when both protected jobs succeed does `publish-release` download and
re-verify the immutable artifact and attach that exact DMG plus its manifest to
the GitHub Release. A manual dispatch from a branch (rather than a tag) fails
the signed-input step; it cannot publish a branch build accidentally. The
release manifest helpers are covered by the same Node test lane as the ad-hoc
UAT helpers:

```text
node --test scripts/uat/release-artifact.test.mjs
```

The contract is documented in
[`release-uat-contract.md`](release-uat-contract.md). Real Developer ID
secrets, notarization, the protected Environments, and an interactive runner
are external GitHub configuration; they are intentionally not represented by
local ad-hoc evidence.

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
