# Native document runtime relocation validation

This records automated packaging and real macOS ARM Runner integration, not Desktop GUI or Windows UAT.

## Correction

Fontconfig configuration and cache no longer reference the build prefix. Poppler data is staged in its platform-specific bundled location. The two macOS upstream CLI entrypoints are rebuilt against the pinned bundled library and initialize GlobalParams with executable-relative data; the library and original CLI behavior remain upstream. Original/modified sources, compiler/SDK arguments, recipe identity and binary hashes accompany the bundle. Cached Poppler identity and complete runtime symlink closure are checked before packaging.

## Evidence

- Native packaging tests with a real relocated Poppler root: eight passed, zero skipped. `/tmp/hatch-native-packaging-real-20260909.log`.
- Agent-run real macOS sandbox integration: two passed, exercising Chinese font discovery and PDF rendering after a second relocation.
- PNG/JPEG/TIFF decoding found non-empty text bounds; direct visual review confirmed Chinese text. `/tmp/hatch-fontconfig-integration.vbYPK0/evidence-formats/image-checks.json`.
- Independent primary-agent inspection of the earlier fixed PNG confirmed readable Chinese rather than the former blank page.
- Full staged runtime symlink check: 1311 links checked by the integration worker.
- LocalRunner local suite: 49 passed, zero failed; three bundled integration tests require explicit execution against a complete runtime.

## CI and remaining gates

macOS CI explicitly runs all three bundled document/font tests against the built app, checks missing Poppler data fails, and retains Chinese rendering evidence. Windows CI uses the runtime root from its bundle verification report to run the new real Runner document fixture, covering DOCX/PPTX/XLSX and non-embedded Chinese PDF. These fixtures remain test-only and cannot serve as Desktop product UAT.

Windows code has passed target compilation, not actual Windows execution. Final macOS/Windows packages, their CI results and target-device UAT remain required. This change alone does not establish a completed Desktop release.
