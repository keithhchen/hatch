import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_DOWNLOAD_TARGETS,
  desktopDownloadUrl,
  detectDownloadTarget,
  detectDownloadTargetAsync,
  normalizeDownloadBaseUrl
} from "./downloadPresentation.js";

test("builds fixed latest download URLs without exposing release versions", () => {
  assert.equal(
    desktopDownloadUrl("macos-apple-silicon", "https://downloads.example.com/desktop/latest/"),
    "https://downloads.example.com/desktop/latest/mac/apple-silicon.dmg"
  );
  assert.equal(desktopDownloadUrl("windows", ""), "");
  assert.equal(normalizeDownloadBaseUrl("http://insecure.example.com"), "");
  assert.equal(DESKTOP_DOWNLOAD_TARGETS.windows.label, "Windows");
});

test("detects supported platforms from user-agent client hints", () => {
  assert.equal(
    detectDownloadTarget({ userAgentData: { platform: "macOS", architecture: "arm" } }),
    "macos-apple-silicon"
  );
  assert.equal(
    detectDownloadTarget({ userAgentData: { platform: "macOS", architecture: "x86" } }),
    "macos-intel"
  );
  assert.equal(detectDownloadTarget({ userAgentData: { platform: "Windows" } }), "windows");
  assert.equal(detectDownloadTarget({ platform: "MacIntel" }), "unknown");
});

test("uses high-entropy architecture only when the browser exposes it", async () => {
  const navigatorLike = {
    userAgentData: {
      platform: "macOS",
      getHighEntropyValues: async () => ({ architecture: "arm" })
    }
  };
  assert.equal(await detectDownloadTargetAsync(navigatorLike), "macos-apple-silicon");
});
