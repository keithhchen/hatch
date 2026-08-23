# Hatch Desktop download distribution v1

## User-facing contract

`/download` is a public, unauthenticated page. It uses the shared Hatch UI
system and keeps the visible choice small:

- one recommended primary download;
- Mac Apple Silicon, Mac Intel, and Windows as alternate choices;
- a small preview-build label for the current unsigned/UAT distribution;
- no visible version number, filename, SHA-256, runner, or storage details.

The recommendation is determined locally from the browser platform. Chromium
User-Agent Client Hints are used when available. A Mac browser that cannot
reliably expose its CPU architecture leaves the user at the version chooser;
it must not silently send the wrong DMG.

## OSS layout

The GitHub tag workflow writes immutable packages under a versioned prefix and
updates only these fixed public objects:

```text
desktop/releases/v0.1.17/
  Hatch-0.1.17-macOS-Apple-Silicon.dmg
  Hatch-0.1.17-macOS-Intel.dmg
  Hatch-0.1.17-Windows-x64-Setup.exe
  manifest.json

desktop/latest/
  mac/apple-silicon.dmg
  mac/intel.dmg
  windows/windows.exe
  manifest.json
```

The page links only to the three `desktop/latest/` objects. Each new tag
uploads the versioned objects first, then replaces the three latest aliases
and the latest manifest. Latest aliases use revalidation-oriented cache
headers; versioned objects are immutable and long-cacheable.

The tag job refuses to move `desktop/latest/manifest.json` backwards to an
older version. Re-running the same version is allowed only when its source
commit is identical; a same-version/different-commit collision fails closed.

`manifest.json` is the machine-readable release record. It stores the release
version/tag, source commit, publication time, human-facing artifact labels,
versioned/latest URLs, byte counts, and SHA-256 values. Its contract is
`release/desktop-download-manifest.schema.json`; the generator and evidence
checks live in `scripts/release/create-desktop-download-manifest.mjs`.

For reproducible reruns, `published_at` is derived from the immutable
annotated tag timestamp rather than the runner clock.

The manifest is not rendered into the page. This keeps the download surface
quiet while retaining a durable source of truth for release operations.

The current CI distribution lane publishes ad-hoc macOS and unsigned Windows
UAT candidates. It is not a signed production-distribution claim. The
protected signed macOS validation lane remains separate until its external
credentials and target-device approvals exist.

## GitHub configuration

Use a dedicated public-download OSS bucket (or a CDN-backed public prefix).
Do not reuse `HATCH_CREATOR_OBJECT_STORE_BUCKET`: that bucket contains private
Creator originals and generated artifacts. Public-read access should be scoped
to the Desktop download objects only.

The one-time bucket, RAM policy, and GitHub configuration procedure is in
[`desktop-download-oss-setup.md`](desktop-download-oss-setup.md).

The `Hatch Desktop CI` tag job needs these repository variables:

```text
HATCH_OSS_BUCKET              # OSS bucket name
HATCH_OSS_REGION              # e.g. cn-shanghai, without the oss- prefix
HATCH_OSS_S3_ENDPOINT         # e.g. https://s3.oss-cn-shanghai.aliyuncs.com
HATCH_OSS_PUBLIC_BASE_URL     # e.g. https://bucket.oss-cn-shanghai.aliyuncs.com
HATCH_DESKTOP_DOWNLOAD_BASE_URL
                              # public base URL + /desktop/latest
```

It also needs these repository secrets:

```text
HATCH_OSS_ACCESS_KEY_ID
HATCH_OSS_ACCESS_KEY_SECRET
```

The access key is used only by GitHub Actions for object upload. The browser
receives public GET URLs and never receives OSS credentials.

The Web CD must build with `VITE_HATCH_DESKTOP_DOWNLOAD_BASE_URL` set to the
same public `desktop/latest` prefix. If it is missing, the page shows the real
unavailable state instead of inventing a fallback download URL.

The workflow verifies all three fixed URLs by downloading them back from the
public OSS endpoint and comparing their bytes to the CI evidence SHA-256. It
does not create a GitHub Release, so GitHub's automatic source-code assets are
not part of the desktop distribution surface.
