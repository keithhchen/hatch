# Desktop attachment parity: Codex GUI and app-server

Research date: 2026-09-08. This is a source comparison, not a claim that Hatch
already implements every behavior or that target-device UAT passed.

## Source boundary

### CLI implementation cross-check (2026-09-09)

Inspected upstream source, not a live model session; this is not product UAT.
Observed upstream heads: Codex `b4d42052cd0fe621cec83dd35582676904ce958c`,
Kimi CLI `86f136422a0aae6b217ea49e7ea1d2e8a1defcd2`.

- Codex `codex-rs/core/src/tools/handlers/view_image.rs` reads image bytes
  through the environment filesystem with sandbox context, validates the image,
  and returns a structured `InputImage` tool result containing a data URL.
  History insertion owns image preparation/resizing. Logging omits image bytes.
- Kimi CLI `src/kimi_cli/tools/file/read_media.py` checks model media capability,
  reads image bytes, and returns `ImageURLPart` with a base64 data URL. Generated
  media must be read back; a shell output path alone is not model vision.
- Kimi CLI `src/kimi_cli/tools/file/read.py` is a text reader. Unsupported binary
  inputs direct the model to shell/Python/MCP tools; it does not automatically
  turn Office/PDF files into document understanding. The inspected source tree
  does not establish that every CLI installation bundles Office conversion
  tools or document skills. Do not equate CLI and desktop packaging evidence.
- Hatch's implementation boundary remains small: native file references,
  generic runner execution, structured image results, and document skills using
  real toolchains. Do not add parallel automatic document extraction in history
  replay or format-specific agent loops. Dependency packaging and cloud/local
  transport are Hatch responsibilities, not reasons to reinvent document tools.

- Official app-server documentation: https://learn.chatgpt.com/docs/app-server
- Installed GUI: `/Applications/ChatGPT.app/Contents/Resources/app.asar`,
  `openai-codex-electron 26.901.51231`.
- GUI evidence below uses paths inside that archive and zero-based UTF-16
  character offsets in the shipped bundles, not fictional source line numbers.
- Public app-server and installed GUI may have different versions. Do not treat
  a GUI acceptance response as proof of an app-server fsync guarantee.

## Verified GUI behavior

1. **Recoverable submission.** The composer can clear optimistically while a
   draft is retained. Failure restoration avoids overwriting newer input.
   `turn/start` acceptance binds the actual turn ID; an `outcome-unknown` state
   prevents blind resubmission. Evidence: `webview/assets/app-primary-6cd7b8b3f5e3.js`
   `gXr` at 7638470; `webview/assets/app-initial-cadb12d4a15e.js` `cun` and adjacent
   `lun`/`iun`/`aun`/`oun` at 2907717, `Neo` at 7599412, `D0` at 7604904.
2. **Managed files exist, but ownership is mixed.** `createManagedFileAttachment`
   writes under `getCodexHome()/attachments/<UUID>/...`, registers the attachment,
   and cleans up if registration fails. `createLocalFile` uses `fs/copy`.
   Pending removal has retries. Other image paths can remain source paths or
   temporary clipboard files; not every Codex attachment is a durable copy.
   Evidence: initial bundle `Sen` at 2694050 and `copyLocalFileAttachment` at
   2997850; primary `eXt` at 1941032; main bundle
   `.vite/build/main-BT6ViFC-.js` `persistImageFileToTemp` at 1942289.
3. **History and item detail are separate.** `thread/turns/list` can request
   `itemsView: "notLoaded"`; `thread/items/list` fills details. Requests are
   deduplicated, checked against generation/cancellation, and merged without
   overwriting concurrent live changes. Evidence: initial bundle `Q4t` at
   2535061, `PS` near 2534634, `$4t.loadTurnItems` at 2536900.
4. **Shared preview cache with explicit lifecycle.** Asset-pointer/resolver
   keyed queries expose loading/error/refetch. Blob URLs are tracked and revoked.
   Binary reads and data URLs also exist: do not claim Codex universally avoids
   base64, uses thumbnails, or uses viewport lazy loading. Evidence: initial
   bundle `nXr` at 4665829 and adjacent `oXr`/`mXr`/`sXr`; `JLr`/`YLr` at 4475427.
5. **Visible failures, not universal retry.** Upload failure handling clears
   pending state or removes failed attachments; previews have unavailable states
   and some refetch controls. Evidence: primary `aFr` at 7170605, initial `ksa`
   near 6613100, `webview/assets/viewer-142e91b0720e.js` `yp` near 97489.

## Hatch implementation requirements

### Verified current app-server boundary

Official source commit:
`54e04f25dbfe342bf84809d1880dbca32cb43cf6` (2026-09-08T04:47:42Z).

- Local images become processed image data URLs with detail in model history;
  UI events retain original paths for reattachment. This does not prove the
  original path remains available forever. See
  [models.rs](https://github.com/openai/codex/blob/54e04f25dbfe342bf84809d1880dbca32cb43cf6/codex-rs/protocol/src/models.rs#L1992)
  and [protocol.rs](https://github.com/openai/codex/blob/54e04f25dbfe342bf84809d1880dbca32cb43cf6/codex-rs/protocol/src/protocol.rs#L2522).
- The current image preparation code rejects HTTP(S) image URLs, despite the
  documentation example. Do not build parity assumptions on that example alone:
  [image_preparation.rs](https://github.com/openai/codex/blob/54e04f25dbfe342bf84809d1880dbca32cb43cf6/codex-rs/core/src/image_preparation.rs#L267).
- `fs/writeFile` and `fs/readFile` transport file bytes. They do not alone
  establish a conversation attachment association; the input enum has no
  generic PDF/Office file member. See
  [fs_processor.rs](https://github.com/openai/codex/blob/54e04f25dbfe342bf84809d1880dbca32cb43cf6/codex-rs/app-server/src/request_processors/fs_processor.rs#L64)
  and [turn.rs](https://github.com/openai/codex/blob/54e04f25dbfe342bf84809d1880dbca32cb43cf6/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L394).
- The rollout writer calls `write_all` then `flush`. This is not evidence of
  `fsync` or of the exact ordering between durable flush and RPC acceptance:
  [recorder.rs](https://github.com/openai/codex/blob/54e04f25dbfe342bf84809d1880dbca32cb43cf6/codex-rs/rollout/src/recorder.rs#L1996).

### Adaptation for Hatch

- Preserve the user's existing requirement: binary storage must succeed before
  its immutable reference is committed with the user message. Historical reads
  must return that recorded reference, not assemble attachments from another
  source of truth after the fact.
- Use the managed-attachment pattern for files users actually upload. Do not
  copy Codex's temporary/local path variants into cloud Runtime persistence.
  Local shared-filesystem access and Hatch cloud transport are not equivalent.
- Separate selected/preparing/submitting/accepted/failed/outcome-unknown states.
  Keep a recoverable draft and attachment handles until submission is resolved;
  use the same logical message identity for a retry, after reconciliation.
- Add shared, account/conversation/asset-scoped preview loading with request
  deduplication, stale-response cancellation, bounded caching and URL cleanup.
  Preview failure must not erase the persisted message or attachment card.
- Keep history lightweight and load binary/detail separately. HTTP success is
  not sufficient if returned bytes fail the recorded length/digest check.
- Test fresh upload, navigation away/back, app restart, interrupted submission,
  unknown acceptance, concurrent retry, expired credentials, missing object,
  and model-context compaction. Distinguish automated tests from real OS UAT.

## Current gap, not completed parity

Hatch currently clears the composer after successful WebSocket send, without a
separate acknowledged/unknown submission state; pending native drop contexts
are held in memory. Historical image components read full binary/base64 with
component-local state rather than a shared preview cache. The pagination release
does not by itself close these attachment lifecycle gaps.
