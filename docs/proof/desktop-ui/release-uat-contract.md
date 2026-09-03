# Signed desktop release UAT contract

This document defines what must be true before a signed macOS Desktop DMG is
accepted by the protected target-device validation lane. It is a supply-chain
and target-device contract, not a claim that the local ad-hoc DMG is
publishable. Public macOS distribution is handled separately by the OSS tag
job in `desktop-ci.yml`; the same tag's Windows UAT package is published to
the public GitHub Release repository. Windows signed distribution remains
outside this protected macOS contract.

## Immutable artifact identity

`build-release` writes `release-artifact.json` only after all of the following
have succeeded:

- the run is on a `vMAJOR.MINOR.PATCH` tag;
- the protected `desktop-production` Environment approved the run;
- `HATCH_SIGNED_WORKSPACE_SMOKE_SHA == GITHUB_SHA`;
- `npm run build:distribution` produced a Developer ID-signed app with
  `HATCH_PERSISTENT_SESSION=1`;
- `xcrun notarytool submit --wait` accepted the DMG;
- `xcrun stapler staple` and `xcrun stapler validate` succeeded.

The manifest has this minimum identity:

```json
{
  "schema_version": 1,
  "kind": "hatch-desktop-release-artifact",
  "source": { "git_sha": "<40-hex SHA>", "github_run_id": "<current run>" },
  "release": { "tag": "v1.2.3" },
  "package": {
    "platform": "macos",
    "architecture": "aarch64",
    "filename": "Hatch_1.2.3_aarch64.dmg",
    "bytes": 123,
    "sha256": "sha256:<64 lowercase hex>",
    "release_eligible": true
  },
  "security": {
    "distribution_build": true,
    "persistent_session": "enabled",
    "signed": true,
    "notarized": true
  },
  "provenance": {
    "signing_identity": "Developer ID Application: …",
    "team_id": "<10-character Team ID>",
    "bundle_identifier": "dev.hatch.local"
  }
}
```

The DMG and manifest are uploaded in one immutable Actions artifact. The
manifest is not trusted merely because it is JSON: the target and publication
jobs hash the downloaded DMG again and compare bytes, hash, source SHA, tag,
and the current workflow run ID. A different file, a changed manifest, a
different source, a different tag, or an artifact from another run stops the
lane.

## Target-device gate

`release-target-uat` is deliberately protected and cannot run on
`macos-latest`. Before enabling it, configure:

- Environment `desktop-production` with the Developer ID certificate,
  notarization credentials, Team ID, signing identity, runtime URL, and the
  exact post-signed-app smoke SHA;
- Environment `desktop-release-uat` with required reviewers to authorize use of
  the dedicated interactive runner;
- a disposable, interactive `self-hosted, macos, arm64` runner and a matching
  `self-hosted, macos, x64` Intel runner, both with screen capture permission
  and no production account/data;
- the same default-branch verifier code as the workflow, kept under branch
  protection.

The runner verifies the exact artifact, mounts the DMG read-only, copies the
app to an isolated install directory, and records:

- `codesign --verify --deep --strict`;
- `codesign -dvvv` identity, Team ID, and bundle identifier checks against the
  manifest;
- Gatekeeper assessment via `spctl --assess --type execute`;
- `xcrun stapler validate`;
- cold-launch process state, stdout/stderr, system log, and a screenshot.

The candidate is launched with a minimal environment (`env -i`) so GitHub
Actions credentials are not inherited. `HOME` is preserved because the human
reviewer must exercise the real UAT account and verify that a signed clean
restart reads the Keychain item without an unlock prompt. The workflow never
uses `security` CLI, disables Gatekeeper, or treats a prompt as success.

The required reviewer checklist for the exact `package.sha256` includes:

1. install and cold launch from the stapled DMG;
2. sign in, quit, relaunch, and confirm no repeated Login Keychain prompt;
3. choose a Workspace through the native picker and execute a safe
   `file_list` smoke under the grant;
4. inspect native application/context menus (no `Inspect Element`), Settings,
   traffic lights, resize tiers, zoom, and overflow behavior;
5. record any VoiceOver, drag/drop, IME, fullscreen, multi-display, or
   Workspace grant failure as a failed target UAT, not as a waiver.

The workflow ends after the protected target job and keeps the exact signed
candidate and evidence in Actions artifacts. There is no GitHub Release
publication step in this lane. If no target runner, secret, or review approval
exists, the signed candidate remains unaccepted; local ad-hoc UAT is not a
bypass.

## Local boundary

The local DMG under `docs/proof/installable-desktop-v1.json` is an ad-hoc,
process-memory-only UAT package. It proves the renderer/native implementation
and strict DMG construction, but it cannot satisfy this contract because it is
not Developer ID signed, notarized, or Keychain-tested after restart.
