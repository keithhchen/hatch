// Lightweight function-level native regression, not AppKit/OS UAT.
// Reuses an EXISTING cargo test dependency directory; never builds the app.
// HATCH_NATIVE_TEST_DEPS=/path/to/target/debug/deps node scripts/test-artifact-workers.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

assert.equal(process.platform, "darwin", "This lightweight regression runs on macOS");
const deps = process.env.HATCH_NATIVE_TEST_DEPS;
assert.ok(deps, "Provide an existing HATCH_NATIVE_TEST_DEPS; no dependencies will be built");
const tauri = readdirSync(deps).filter((name) => /^libtauri-[a-f0-9]+\.rlib$/.test(name));
assert.equal(tauri.length, 1, "Use a dependency directory with one unambiguous Tauri build");
const source = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
function between(start, end) {
  const index = source.indexOf(start);
  const boundary = source.indexOf(end, index + start.length);
  assert.ok(index >= 0 && boundary > index, `Missing source boundary ${start}`);
  return source.slice(index, boundary).trim();
}
const commands = [
  between("async fn reveal_workspace_artifact(", "/// Open an artifact"),
  between("async fn open_workspace_artifact(", "fn open_workspace_artifact_with_platform("),
  between("fn resolve_workspace_artifact_path(", "#[tauri::command]\nfn set_window_tool_context(")
].join("\n");
// AppKit must remain in the existing explicit main-thread dispatch. Runtime
// tests below replace OS presentation only, so this placement is checked here.
const mac = between("fn open_workspace_artifact_macos(", '#[cfg(target_os = "windows")]');
for (const marker of ["run_on_main(move |mtm|", "QuickLookPanel::shared()", "PreviewItem::from_file_url", "match panel_result", 'Command::new("/usr/bin/qlmanage")']) {
  assert.ok(mac.includes(marker), `Missing AppKit placement marker: ${marker}`);
}
assert.ok(mac.indexOf("run_on_main(move |mtm|") < mac.indexOf("QuickLookPanel::shared()"));
assert.ok(mac.indexOf("run_on_main(move |mtm|") < mac.indexOf("PreviewItem::from_file_url"));
assert.ok(mac.indexOf("match panel_result") < mac.indexOf('Command::new("/usr/bin/qlmanage")'));
const directory = mkdtempSync(path.join(os.tmpdir(), "hatch-artifact-worker-test-"));
try {
  const extracted = path.join(directory, "commands.rs");
  writeFileSync(extracted, commands);
  const output = path.join(directory, "tests");
  execFileSync(process.env.RUSTC || "rustc", ["--edition=2021", "--test",
    new URL("../src-tauri/tests/fixtures/artifact_worker_fixture.rs", import.meta.url).pathname,
    "-L", `dependency=${deps}`, "--extern", `tauri=${path.join(deps, tauri[0])}`,
    "-o", output], { stdio: "inherit", env: { ...process.env, HATCH_ARTIFACT_COMMAND_SOURCE: extracted } });
  execFileSync(output, ["--nocapture"], { stdio: "inherit" });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
