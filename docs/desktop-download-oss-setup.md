# Desktop download OSS setup

This is the one-time external setup for the Desktop download distribution
lane. The repository owns the object layout and manifest contract; Alibaba
Cloud OSS stores the immutable release packages and the fixed `latest` aliases.

## 1. Create a dedicated bucket

Create a separate OSS bucket for public Desktop downloads in the region where
the public download traffic should be served. Do not reuse
`HATCH_CREATOR_OBJECT_STORE_BUCKET`: it contains private Creator originals and
generated artifacts.

For a Shanghai bucket, use:

```text
HATCH_OSS_REGION=cn-shanghai
HATCH_OSS_S3_ENDPOINT=https://s3.oss-cn-shanghai.aliyuncs.com
HATCH_OSS_PUBLIC_BASE_URL=https://<download-bucket>.oss-cn-shanghai.aliyuncs.com
HATCH_DESKTOP_DOWNLOAD_BASE_URL=https://<download-bucket>.oss-cn-shanghai.aliyuncs.com/desktop/latest
```

`HATCH_OSS_S3_ENDPOINT` is the S3-compatible upload endpoint. The public base
URL is the ordinary bucket download domain. OSS requires virtual-hosted-style
requests for S3-compatible access; the workflow therefore keeps the bucket
name in the `--bucket` argument and does not use path-style addressing. The
publish job also sets AWS CLI checksum calculation to `when_required`, because
OSS does not accept AWS's streaming checksum trailer for multipart uploads, and
sets `public-read` explicitly with `PutObjectACL` so the private bucket can
serve only the published objects anonymously. The latest-manifest guard reads
the current object with authenticated S3 metadata instead of probing its public
URL, because a missing object in a private bucket can correctly return 403 to
anonymous callers.

If the bucket uses another region, replace `cn-shanghai` in all four values
with that region ID and use the matching endpoint.

## 2. Create a release-only RAM identity

Create a RAM user or role used only by GitHub Actions. Attach a custom policy
scoped to the Desktop prefix. It needs to upload and verify objects and set
the object ACL to `public-read`; it does not need bucket listing, deletion, or
access to any other prefix.

Replace `<account-id>` and `<download-bucket>` before attaching this policy:

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:PutObject",
        "oss:GetObject",
        "oss:PutObjectAcl"
      ],
      "Resource": [
        "acs:oss:*:<account-id>:<download-bucket>/desktop/*"
      ]
    }
  ]
}
```

The workflow never deletes an immutable versioned object. `GetObject` covers
the authenticated `HeadObject` check used to refuse a conflicting overwrite.
The upload command sets only the `public-read` object ACL; never grant
`public-read-write`.

## 3. Add GitHub repository configuration

Set these repository variables on `keithhchen/hatch`:

```text
HATCH_OSS_BUCKET
HATCH_OSS_REGION
HATCH_OSS_S3_ENDPOINT
HATCH_OSS_PUBLIC_BASE_URL
HATCH_DESKTOP_DOWNLOAD_BASE_URL
```

Set these repository secrets:

```text
HATCH_OSS_ACCESS_KEY_ID
HATCH_OSS_ACCESS_KEY_SECRET
```

Example commands (the secret values are entered interactively and are never
written to the repository):

```bash
gh variable set HATCH_OSS_BUCKET --repo keithhchen/hatch --body '<download-bucket>'
gh variable set HATCH_OSS_REGION --repo keithhchen/hatch --body 'cn-shanghai'
gh variable set HATCH_OSS_S3_ENDPOINT --repo keithhchen/hatch --body 'https://s3.oss-cn-shanghai.aliyuncs.com'
gh variable set HATCH_OSS_PUBLIC_BASE_URL --repo keithhchen/hatch --body 'https://<download-bucket>.oss-cn-shanghai.aliyuncs.com'
gh variable set HATCH_DESKTOP_DOWNLOAD_BASE_URL --repo keithhchen/hatch --body 'https://<download-bucket>.oss-cn-shanghai.aliyuncs.com/desktop/latest'
gh secret set HATCH_OSS_ACCESS_KEY_ID --repo keithhchen/hatch
gh secret set HATCH_OSS_ACCESS_KEY_SECRET --repo keithhchen/hatch
```

The workflow validates that the download base is exactly
`HATCH_OSS_PUBLIC_BASE_URL/desktop/latest`. The Dashboard Web CD consumes the
same value as `VITE_HATCH_DESKTOP_DOWNLOAD_BASE_URL`; it must not be copied
into source code.

## 4. What OSS stores

Every annotated `vMAJOR.MINOR.PATCH` tag writes the two macOS packages and a
manifest under an immutable versioned prefix, then updates the fixed aliases:

```text
desktop/releases/v0.1.17/
  Hatch-0.1.17-macOS-Apple-Silicon.dmg
  Hatch-0.1.17-macOS-Intel.dmg
  manifest.json

desktop/latest/
  mac/apple-silicon.dmg
  mac/intel.dmg
  manifest.json
```

At the current implementation stage these are ad-hoc macOS UAT candidates.
Windows builds are paused until the Windows LocalRunner and target-device
runner are ready. The OSS layout is production-safe for version and artifact
identity, but the packages must not be described as signed production
distribution until the protected signing and target-device gates are complete.

`desktop/latest/manifest.json` is the current version pointer and the machine
source of truth for version, tag, source commit, publication time, download
URLs, byte counts, and SHA-256 values. The download page never renders those
implementation details; it links the two fixed latest objects only.

The versioned objects are immutable and can be retained for rollback/audit.
The latest aliases are the only mutable objects. The tag job downloads the
latest manifest and both latest packages back through their public URLs and
compares their SHA-256 values before it succeeds. It also refuses to move
the latest pointer backwards: an older tag cannot replace a newer current
version, and a same-version tag with a different source SHA fails closed.

Official OSS references:

- [S3-compatible OSS endpoints and client settings](https://help.aliyun.com/en/oss/developer-reference/use-aws-sdks-to-access-oss)
- [Supported S3 operations, virtual-hosted addressing, and object ACLs](https://help.aliyun.com/en/oss/developer-reference/compatibility-with-amazon-s3)
